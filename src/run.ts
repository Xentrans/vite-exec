import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  createRunnableDevEnvironment,
  createServerModuleRunner,
  resolveConfig,
  type RunnableDevEnvironment,
  type ServerModuleRunnerOptions,
} from "vite";
import { help, parseCliArgs } from "./args.js";
import { CJSModuleEvaluator } from "./evaluator.js";

async function readPkgVersion(pkgPath: string | URL): Promise<string> {
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  return pkg.version as string;
}

function getVersion(): Promise<string> {
  return readPkgVersion(new URL("../package.json", import.meta.url));
}

function getViteVersion(): Promise<string> {
  const vitePkgPath = createRequire(import.meta.url).resolve("vite/package.json");
  return readPkgVersion(vitePkgPath);
}

export async function main(args: string[]) {
  const { values, positionals, forwardedArgs } = parseCliArgs(args);

  if (values.help) {
    console.log(help);
    process.exit(0);
  }

  if (values.version) {
    console.log(await getVersion());
    process.exit(0);
  }

  const filePath = positionals[0];
  if (!filePath) {
    console.error("Error: No file specified.\n");
    console.error(help);
    process.exit(1);
  }

  const resolvedPath = resolve(process.cwd(), filePath);

  try {
    accessSync(resolvedPath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const verbose = values.verbose;

  if (verbose) {
    const [version, viteVersion] = await Promise.all([
      getVersion(),
      getViteVersion(),
    ]);
    console.error(`vite-exec v${version} | vite v${viteVersion}`);
    console.error("---");
  }

  const config = await resolveConfig(
    {
      configFile: false,
      envDir: false,
      logLevel: verbose ? "info" : "silent",
      resolve: { tsconfigPaths: true },
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
