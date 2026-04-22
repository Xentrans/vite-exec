#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { resolve, extname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import {
  resolveConfig,
  createRunnableDevEnvironment,
  createServerModuleRunner,
  type RunnableDevEnvironment,
  type ServerModuleRunnerOptions,
} from "vite";

const help = `
Usage: vite-exec [options] <file> [...args]

Run a JS/TS file through Vite's transform pipeline.

Options:
  -r, --require <mod>  Preload a module before running the script (repeatable)
  -w, --watch          Re-run the script when files change
  -e, --ext <exts>     Extensions to watch, comma-separated (default: ts,js,mjs,mts,json)
  -i, --ignore <pat>   Ignore pattern for watch mode (repeatable)
  -d, --delay <ms>     Debounce delay in ms for watch restarts (default: 200)
      --clear          Clear screen before each restart
  -q, --quiet          Suppress [vite-exec] messages
      --verbose        Show diagnostic info
  -h, --help           Show this help message
  -v, --version        Show version
`.trim();

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

const cliOptions = {
  require: { type: "string" as const, short: "r", multiple: true, default: [] },
  watch: { type: "boolean" as const, short: "w", default: false },
  ext: { type: "string" as const, short: "e" },
  ignore: { type: "string" as const, short: "i", multiple: true, default: [] },
  delay: { type: "string" as const, short: "d" },
  clear: { type: "boolean" as const, default: false },
  quiet: { type: "boolean" as const, short: "q", default: false },
  verbose: { type: "boolean" as const, default: false },
  help: { type: "boolean" as const, short: "h", default: false },
  version: { type: "boolean" as const, short: "v", default: false },
};

const shortFlagMap = new Map(
  Object.values(cliOptions)
    .filter((opt) => "short" in opt)
    .map((opt) => [opt.short!, opt]),
);

function optionTakesValue(arg: string): boolean {
  // For long flags (--foo), the whole name is the key.
  // For short flag clusters (-abc), only the LAST char can be a
  // value-taking flag (node's parseArgs parses -wr as -w -r, where
  // only -r takes a value). For the plain single-letter case -x,
  // slice(-1) returns "x", so both cases use the same lookup.
  const key = arg.replace(/^-+/, "").split("=")[0];
  const opt = arg.startsWith("--")
    ? cliOptions[key as keyof typeof cliOptions]
    : shortFlagMap.get(key.slice(-1));
  return opt?.type === "string" && !arg.includes("=");
}

function parseCliArgs(args: string[]) {
  // Split args: everything before the file is for vite-exec,
  // everything after is forwarded to the script. An explicit
  // -- also works as a separator.
  //
  // Examples:
  //   vite-exec --verbose script.ts --port 3000
  //   vite-exec -r dotenv/config script.ts --port 3000
  //   vite-exec script.ts -- --flag   (-- is forwarded to the script too)

  const ownArgs: string[] = [];
  let forwardedArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      forwardedArgs = args.slice(i + 1);
      break;
    }
    if (!arg.startsWith("-")) {
      ownArgs.push(arg);
      forwardedArgs = args.slice(i + 1);
      break;
    }
    ownArgs.push(arg);
    if (optionTakesValue(arg) && i + 1 < args.length) {
      ownArgs.push(args[++i]);
    }
  }

  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: cliOptions,
    allowPositionals: true,
  });

  return { values, positionals, forwardedArgs };
}

async function main() {
  const { values, positionals, forwardedArgs } = parseCliArgs(
    process.argv.slice(2),
  );

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

const DEFAULT_WATCH_EXTS = new Set(["ts", "js", "mjs", "mts", "json"]);

function buildChildArgs(args: string[]): string[] {
  // Reconstruct args from parsed values (not string manipulation) so
  // combined shorts like -wq don't leak. Watch-only options are
  // intentionally dropped — critically, -w is stripped so the child
  // runs main() instead of re-entering watchMode() and forking forever.
  const { values, positionals, forwardedArgs } = parseCliArgs(args);
  const childArgs: string[] = [];

  for (const mod of values.require ?? []) {
    childArgs.push("-r", mod);
  }
  if (values.verbose) childArgs.push("--verbose");

  childArgs.push(...positionals, ...forwardedArgs);

  return childArgs;
}

async function watchMode(args: string[]) {
  const cliPath = fileURLToPath(import.meta.url);
  const { values } = parseCliArgs(args);
  const childArgs = buildChildArgs(args);

  const watchExts = values.ext
    ? new Set(values.ext.split(",").map((e) => e.trim().replace(/^\./, "")))
    : DEFAULT_WATCH_EXTS;
  const delay = values.delay ? parseInt(values.delay, 10) : 200;
  if (Number.isNaN(delay)) {
    console.error("Error: --delay must be a number");
    process.exit(1);
  }
  const clearScreen = values.clear;
  const quiet = values.quiet;

  const ignoredPatterns = [
    "**/node_modules/**",
    "**/.git/**",
    "**/bower_components/**",
    "**/.nyc_output/**",
    "**/coverage/**",
    "**/.sass-cache/**",
    "**/dist/**",
    ...(values.ignore ?? []),
  ];

  let child: ChildProcess | undefined;
  let restarting = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function log(msg: string) {
    if (!quiet) console.error(msg);
  }

  function spawnChild() {
    restarting = false;
    if (clearScreen) process.stderr.write("\x1Bc");
    child = spawn(process.execPath, [cliPath, ...childArgs], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (code) => {
      child = undefined;
      if (code !== null && code !== 0) {
        log(`\n[vite-exec] process exited with code ${code}, waiting for changes...`);
      }
    });
  }

  function killAndRestart() {
    // Coalesce overlapping restart requests: while a kill is in flight,
    // further triggers (debounce fire, stdin 'rs', another file change)
    // would each attach a new exit listener and spawn extra children.
    if (restarting) return;
    if (child) {
      restarting = true;
      child.once("exit", () => spawnChild());
      child.kill("SIGTERM");
    } else {
      spawnChild();
    }
  }

  function restart(filePath: string) {
    const ext = extname(filePath).slice(1);
    if (ext && !watchExts.has(ext)) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const display = relative(process.cwd(), filePath) || filePath;
      log(`\n[vite-exec] change detected: ${display}, restarting...`);
      killAndRestart();
    }, delay);
  }

  // Manual restart via 'rs' + Enter, but only in TTY mode — otherwise
  // we'd steal stdin from scripts that read from it (piped input, tests).
  if (process.stdin.isTTY) {
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    let buf = "";
    process.stdin.on("data", (data: string) => {
      buf += data;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "rs") {
          log("[vite-exec] manual restart");
          killAndRestart();
        }
      }
    });
  }

  const { watch: chokidarWatch } = await import("chokidar");
  const watcher = chokidarWatch(process.cwd(), {
    ignoreInitial: true,
    ignored: ignoredPatterns,
  });
  watcher.on("all", (_event, filePath) => restart(filePath));
  watcher.on("error", (err) => {
    // Only surface EMFILE with a helpful hint; chokidar emits many
    // transient errors (e.g. ENOENT on rapidly deleted files) that
    // would spam the user without adding useful information.
    if ((err as NodeJS.ErrnoException).code === "EMFILE") {
      log("[vite-exec] too many open files — try closing other programs or raising ulimit");
    }
  });

  // Exit codes: 128 + signal number, per POSIX shell convention.
  for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(signal, () => {
      if (child) child.kill("SIGTERM");
      process.exit(exitCode);
    });
  }

  const extList = [...watchExts].join(",");
  log(`[vite-exec] watching for changes (ext: ${extList}, delay: ${delay}ms)...`);
  spawnChild();
}

const args = process.argv.slice(2);
const isWatchMode = args.includes("--watch") || args.includes("-w");
const entry = isWatchMode ? watchMode(args) : main();
entry.catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
