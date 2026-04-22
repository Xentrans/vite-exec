import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { buildChildArgs, parseCliArgs } from "./args.js";

const DEFAULT_WATCH_EXTS = new Set(["ts", "js", "mjs", "mts", "json"]);

export async function watchMode(args: string[]) {
  // Path to this file's own compiled output; spawned children re-enter the
  // same CLI but without the watch flag (buildChildArgs strips it).
  const cliPath = resolve(fileURLToPath(import.meta.url), "../cli.js");
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
