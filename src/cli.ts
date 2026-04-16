#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { resolve, extname, relative } from "node:path";
import { pathToFileURL } from "node:url";
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
import tsconfigPaths from "vite-tsconfig-paths";

const help = `
Usage: vite-exec [options] <file> [-- ...args]

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

async function getVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf-8"),
  );
  return pkg.version as string;
}

async function getViteVersion(): Promise<string> {
  const selfRequire = createRequire(import.meta.url);
  const vitePkgPath = selfRequire.resolve("vite/package.json");
  const pkg = JSON.parse(await readFile(vitePkgPath, "utf-8"));
  return pkg.version as string;
}

function parseCliArgs(args: string[]) {
  const ddIndex = args.indexOf("--");
  const ownArgs = ddIndex === -1 ? args : args.slice(0, ddIndex);
  const forwardedArgs = ddIndex === -1 ? [] : args.slice(ddIndex + 1);

  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: {
      require: { type: "string", short: "r", multiple: true, default: [] },
      watch: { type: "boolean", short: "w", default: false },
      ext: { type: "string", short: "e" },
      ignore: { type: "string", short: "i", multiple: true, default: [] },
      delay: { type: "string", short: "d" },
      clear: { type: "boolean", default: false },
      quiet: { type: "boolean", short: "q", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
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

  const verbose = values.verbose ?? false;

  if (verbose) {
    const version = await getVersion();
    const viteVersion = await getViteVersion();
    console.error(`vite-exec v${version} | vite v${viteVersion}`);
    console.error("---");
  }

  const config = await resolveConfig(
    {
      configFile: false,
      envDir: false,
      logLevel: verbose ? "info" : "silent",
      plugins: [tsconfigPaths()],
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

  try {
    for (const mod of values.require ?? []) {
      if (mod.startsWith(".") || mod.startsWith("/")) {
        await environment.runner.import(resolve(process.cwd(), mod));
      } else {
        const cwdRequire = createRequire(
          pathToFileURL(resolve(process.cwd(), "noop.js")).href,
        );
        await import(cwdRequire.resolve(mod));
      }
    }
    await environment.runner.import(resolvedPath);
  } catch (err) {
    if (verbose && err instanceof Error) {
      console.error(err);
    } else if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error:", err);
    }
    await environment.close();
    process.exit(1);
  }

  // Clean up the environment once the event loop drains, but don't
  // prevent Node from exiting naturally (unlike process.exit, this
  // lets pending promises, timers, and I/O complete first).
  process.on("beforeExit", () => environment.close());
}

const DEFAULT_WATCH_EXTS = new Set(["ts", "js", "mjs", "mts", "json"]);

async function watchMode(args: string[]) {
  const cliPath = new URL(import.meta.url).pathname;
  const { values } = parseCliArgs(args);

  // Strip watch-only flags from args before passing to child
  const watchOnlyFlags = new Set(["--watch", "-w", "--clear", "-q", "--quiet"]);
  const watchOnlyWithValue = new Set(["--ext", "-e", "--ignore", "-i", "--delay", "-d"]);
  const childArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (watchOnlyFlags.has(args[i])) continue;
    if (watchOnlyWithValue.has(args[i])) { i++; continue; }
    childArgs.push(args[i]);
  }

  const watchExts = values.ext
    ? new Set(values.ext.split(",").map((e) => e.trim().replace(/^\./, "")))
    : DEFAULT_WATCH_EXTS;
  const delay = values.delay ? parseInt(values.delay, 10) : 200;
  const clearScreen = values.clear ?? false;
  const quiet = values.quiet ?? false;

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
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function log(msg: string) {
    if (!quiet) console.error(msg);
  }

  function spawnChild() {
    if (clearScreen) process.stderr.write("\x1Bc");
    child = spawn(process.execPath, [cliPath, ...childArgs], {
      stdio: [0, 1, 2],
    });
    child.on("exit", (code) => {
      child = undefined;
      if (code !== null && code !== 0) {
        log(`\n[vite-exec] process exited with code ${code}, waiting for changes...`);
      }
    });
  }

  function restart(filePath: string) {
    const ext = extname(filePath).slice(1);
    if (ext && !watchExts.has(ext)) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const display = relative(process.cwd(), filePath) || filePath;
      log(`\n[vite-exec] change detected: ${display}, restarting...`);
      if (child) {
        child.on("exit", () => spawnChild());
        child.kill("SIGTERM");
      } else {
        spawnChild();
      }
    }, delay);
  }

  // Listen for manual restart via stdin
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
          if (child) {
            child.on("exit", () => spawnChild());
            child.kill("SIGTERM");
          } else {
            spawnChild();
          }
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
    if ((err as NodeJS.ErrnoException).code === "EMFILE") {
      log("[vite-exec] too many open files — try closing other programs or raising ulimit");
    }
  });

  process.on("SIGINT", () => {
    if (child) child.kill("SIGTERM");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    if (child) child.kill("SIGTERM");
    process.exit(143);
  });

  const extList = [...watchExts].join(",");
  log(`[vite-exec] watching for changes (ext: ${extList}, delay: ${delay}ms)...`);
  spawnChild();
}

const args = process.argv.slice(2);
if (args.includes("--watch") || args.includes("-w")) {
  watchMode(args);
} else {
  main();
}
