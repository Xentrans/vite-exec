import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { accessSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { url as inspectorUrl, waitForDebugger } from "node:inspector";
import {
  createRunnableDevEnvironment,
  createServerModuleRunner,
  resolveConfig,
  type Plugin,
  type RunnableDevEnvironment,
  type ServerModuleRunnerOptions,
} from "vite";
import { help, parseCliArgs } from "./args.js";
import { CJSModuleEvaluator } from "./evaluator.js";

declare global {
  // eslint-disable-next-line no-var
  var __vite_exec_modules: Map<string, unknown>;
}

async function readPkgVersion(pkgPath: string | URL): Promise<string> {
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  return pkg.version as string;
}

// Child-side entry point: parses vite-exec flags and actually runs the
// script (or inline eval) through Vite. The parent (cli.ts) handled dispatch,
// --help/--version, and watch mode; this function expects none of those to
// apply here.
export async function runScript(args: string[]) {
  const { values, positionals, forwardedArgs } = parseCliArgs(args);

  const evalCode = values.eval;
  const isEval = evalCode !== undefined;
  const filePath = positionals[0];

  if (!isEval && !filePath) {
    console.error("Error: No file or --eval code specified.\n");
    console.error(help);
    process.exit(1);
  }

  // Synthetic absolute path under cwd — never touched on disk. The Vite
  // plugin below intercepts both resolveId and load for this path, so
  // Vite never tries to read the file. Using a path inside cwd means that
  // relative imports from the eval code (e.g. `import "./foo"`) resolve
  // against cwd naturally, and __dirname/__filename (populated by our
  // CJSModuleEvaluator from import.meta) are what users expect. The `.ts`
  // extension tells Vite to apply the TypeScript transform, so eval code
  // can use TS syntax.
  const evalId = resolve(process.cwd(), "[eval].ts");
  const resolvedPath = isEval ? evalId : resolve(process.cwd(), filePath);

  if (!isEval) {
    try {
      accessSync(resolvedPath);
    } catch {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
  }

  const verbose = values.verbose;

  if (verbose) {
    const [version, viteVersion] = await Promise.all([
      readPkgVersion(new URL("../package.json", import.meta.url)),
      readPkgVersion(createRequire(import.meta.url).resolve("vite/package.json")),
    ]);
    console.error(`vite-exec v${version} | vite v${viteVersion}`);
    console.error("---");
  }

  // Synthetic-module plugin for eval mode. Returning the id from resolveId
  // claims ownership so Vite doesn't try to read evalId from disk; load then
  // supplies the inline code as the module source.
  const evalPlugin: Plugin | undefined = isEval
    ? {
        name: "vite-exec-eval",
        resolveId(id) {
          return id === evalId ? id : null;
        },
        load(id) {
          return id === evalId ? evalCode : null;
        },
      }
    : undefined;

  // When the user asked for --inspect-brk, emit a `debugger;` statement at
  // the top of the entry script so DevTools pauses on the user's first
  // line (not on our CLI entry). We compare the plugin's `id` against both
  // the resolved path AND its realpath, because on macOS /tmp is a symlink
  // to /private/tmp and Vite may canonicalize.
  const wantBrk = process.env._VITE_EXEC_INSPECT_BRK === "1";
  let realResolvedPath: string;
  try {
    realResolvedPath = realpathSync(resolvedPath);
  } catch {
    realResolvedPath = resolvedPath;
  }
  const brkPlugin: Plugin | undefined = wantBrk
    ? {
        name: "vite-exec-inspect-brk",
        enforce: "post",
        transform(code, id) {
          if (id !== resolvedPath && id !== realResolvedPath) return null;
          return { code: `debugger;\n${code}`, map: null };
        },
      }
    : undefined;

  const config = await resolveConfig(
    {
      configFile: false,
      envDir: false,
      logLevel: verbose ? "info" : "silent",
      resolve: { tsconfigPaths: true },
      plugins: [evalPlugin, brkPlugin].filter((p): p is Plugin => p != null),
      environments: {
        exec: {
          consumer: "server",
          dev: { moduleRunnerTransform: true },
          resolve: { external: true, mainFields: [], conditions: ["node", "module-sync"] },
        },
      },
    },
    "serve",
  );

  const environment: RunnableDevEnvironment = createRunnableDevEnvironment(
    "exec",
    config,
    {
      runner(env: RunnableDevEnvironment, opts?: ServerModuleRunnerOptions) {
        const runner = createServerModuleRunner(env, {
          ...opts,
          hmr: { logger: false },
          evaluator: new CJSModuleEvaluator(),
        });
        // Bypass strict named-export checking for externalized modules.
        // Vite's default processImport throws when a type-only export
        // (e.g. `import { Relation } from "typeorm"`) is imported without
        // the `type` keyword. Like Vitest, we relax this check.
        // @ts-expect-error processImport is private in Vite's types
        runner.processImport = (exports: Record<string, unknown>) => exports;
        return runner;
      },
      hot: false,
    },
  );

  await environment.init();

  // Route native `import(".ts")` from externalized code back through the
  // ModuleRunner on this main thread. See src/loader.ts for the hook side.
  //
  // The handler must be wired *after* environment.init() — it closes over
  // environment.runner, which isn't usable until init resolves. port1.unref()
  // keeps the open port from holding the event loop alive once user code
  // settles (the process would otherwise hang on exit).
  globalThis.__vite_exec_modules = new Map<string, unknown>();
  {
    const { MessageChannel } = await import("node:worker_threads");
    const { register } = await import("node:module");
    const { port1, port2 } = new MessageChannel();
    port1.on("message", async ({ id, url }: { id: number; url: string }) => {
      try {
        const mod = await environment.runner.import(url);
        globalThis.__vite_exec_modules.set(url, mod);
        // Send export names so the worker's CJS stub can emit static
        // `exports.X = m.X` assignments that cjs-module-lexer picks up —
        // otherwise Node's CJS→ESM interop can't expose named exports from
        // our runtime-assigned module.exports.
        port1.postMessage({ id, ok: true, names: Object.keys(mod as object) });
      } catch (err) {
        // Manually pack the error so the loader thread can reconstruct one
        // with matching properties. Structured-cloning an Error preserves
        // name/message/stack/cause but drops custom own properties like
        // `.code`, which callers (e.g. code branching on ERR_MODULE_NOT_FOUND)
        // need. Copying own props catches those.
        let payload: unknown;
        if (err instanceof Error) {
          const own: Record<string, unknown> = {};
          for (const key of Object.getOwnPropertyNames(err)) {
            own[key] = (err as unknown as Record<string, unknown>)[key];
          }
          payload = { __viteExecError: true, name: err.name, message: err.message, stack: err.stack, own };
        } else {
          payload = { __viteExecError: false, value: String(err) };
        }
        port1.postMessage({ id, error: payload });
      }
    });
    port1.unref();
    register("./loader.js", import.meta.url, {
      data: { port: port2 },
      transferList: [port2],
    });
  }

  process.argv = [process.execPath, resolvedPath, ...forwardedArgs];

  // createRequire needs a file URL; any filename inside cwd works as the
  // reference point — the require resolves bare specifiers from cwd.
  const cwdRequire = createRequire(
    pathToFileURL(resolve(process.cwd(), "noop.js")).href,
  );

  try {
    for (const mod of values.require ?? []) {
      const isLocalPath = mod.startsWith(".") || mod.startsWith("/");
      if (isLocalPath) {
        await environment.runner.import(resolve(process.cwd(), mod));
      } else {
        await import(cwdRequire.resolve(mod));
      }
    }
    // If the user asked for --inspect-brk, the parent replaced it with
    // --inspect and set this env var. Pause here — right before loading
    // their script — so DevTools breaks at a useful point instead of at
    // cli.js:1. waitForDebugger blocks until a debugger attaches and
    // sends Runtime.runIfWaitingForDebugger (DevTools does this
    // automatically on connect/resume). Guarded by inspectorUrl() because
    // waitForDebugger throws ERR_INSPECTOR_NOT_ACTIVE if the inspector
    // failed to bind (port busy, permission denied, etc.).
    if (process.env._VITE_EXEC_INSPECT_BRK === "1") {
      delete process.env._VITE_EXEC_INSPECT_BRK;
      if (inspectorUrl()) waitForDebugger();
    }
    await environment.runner.import(resolvedPath);
  } catch (err) {
    console.error(err);
    await environment.close();
    process.exit(1);
  }

  // Clean up the environment once the event loop drains, but don't
  // prevent Node from exiting naturally (unlike process.exit, this
  // lets pending promises, timers, and I/O complete first).
  //
  // The `closing` flag prevents re-entry: environment.close()'s async
  // work can keep the loop alive long enough for beforeExit to fire a
  // second time, which without the guard would loop indefinitely.
  let closing = false;
  process.on("beforeExit", () => {
    if (!closing) {
      closing = true;
      environment.close();
    }
  });
}
