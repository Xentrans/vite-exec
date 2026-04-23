import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import picomatch from "picomatch";
import { buildChildArgs, parseCliArgs } from "./args.js";

const DEFAULT_WATCH_EXTS = new Set(["ts", "js", "mjs", "mts", "json"]);

// chokidar 5's `ignored` compares strings by ===; must be a RegExp or function.
const DEFAULT_IGNORE_RE =
  /(^|[\\/])(node_modules|\.git|bower_components|\.nyc_output|coverage|\.sass-cache|dist)([\\/]|$)/;

export function buildIgnored(userPatterns: readonly string[], cwd: string) {
  const userMatchers = userPatterns.map((pattern) => {
    const isMatch = picomatch(pattern, { dot: true });
    return (path: string) => isMatch(relative(cwd, path));
  });
  return [DEFAULT_IGNORE_RE, ...userMatchers];
}

export async function watchMode(
  nodeFlags: string[],
  args: string[],
  childEnv: NodeJS.ProcessEnv,
) {
  // Path to the CLI's compiled entrypoint; spawned children re-enter the
  // same file via the _VITE_EXEC_CHILD sentinel so the parent-side dispatch
  // is skipped.
  const cliPath = resolve(fileURLToPath(import.meta.url), "../cli.js");
  const { values } = parseCliArgs(args);

  if (values.eval !== undefined) {
    console.error("Error: --eval cannot be combined with --watch.");
    process.exit(1);
  }

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

  const userIgnore = Array.isArray(values.ignore) ? values.ignore : [];
  const ignored = buildIgnored(userIgnore, process.cwd());

  let child: ChildProcess | undefined;
  let restarting = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function log(msg: string) {
    if (!quiet) console.error(msg);
  }

  function spawnChild() {
    restarting = false;
    if (clearScreen) process.stderr.write("\x1Bc");
    child = spawn(
      process.execPath,
      [...nodeFlags, cliPath, ...childArgs],
      { stdio: ["ignore", "inherit", "inherit"], env: childEnv },
    );
    child.on("error", (err) => {
      child = undefined;
      log(`\n[vite-exec] failed to spawn child: ${err.message}`);
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
      const c = child;
      c.once("exit", () => spawnChild());
      c.kill("SIGTERM");
      // Backstop: if SIGTERM is ignored or held (e.g. an attached inspector
      // waiting for the debugger to disconnect), force-kill after 2s.
      const force = setTimeout(() => c.kill("SIGKILL"), 2000).unref();
      c.once("exit", () => clearTimeout(force));
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
    ignored,
  });
  watcher.on("all", (_event, filePath) => restart(filePath));
  // Only surface EMFILE: chokidar emits many transient errors (e.g. ENOENT
  // on rapidly deleted files) that aren't actionable. EMFILE itself can
  // repeat per-readdir under pressure, so throttle to once per second.
  let lastEmfileLog = 0;
  watcher.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code !== "EMFILE") return;
    const now = Date.now();
    if (now - lastEmfileLog < 1000) return;
    lastEmfileLog = now;
    log("[vite-exec] too many open files — try closing other programs or raising ulimit");
  });

  // Exit codes: 128 + signal number, per POSIX shell convention.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      child?.kill("SIGTERM");
      process.exit(128 + (osConstants.signals[sig] ?? 0));
    });
  }

  const extList = [...watchExts].join(",");
  log(`[vite-exec] watching for changes (ext: ${extList}, delay: ${delay}ms)...`);
  spawnChild();
}
