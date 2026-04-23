#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import {
  help,
  parseCliArgs,
  splitArgs,
  translateInspectBrk,
} from "./args.js";

function die(err: unknown): never {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

// Child mode: the parent re-invoked us via `node [...nodeFlags] cli.js [...]`
// with this env var set. Skip the spawn path; run the script directly.
if (process.env._VITE_EXEC_CHILD === "1") {
  // Scrub the sentinel before running user code so any vite-exec invocation
  // done from the user's script (via spawn, exec, a shell out, etc.) doesn't
  // inherit our child-mode flag and skip its own parent-side dispatch.
  delete process.env._VITE_EXEC_CHILD;
  try {
    const { runScript } = await import("./run.js");
    await runScript(process.argv.slice(2));
  } catch (err) {
    die(err);
  }
} else {
  await parentMain(process.argv.slice(2));
}

async function parentMain(argv: string[]): Promise<void> {
  const split = splitArgs(argv);
  const { nodeFlags, wantInspectBrk } = translateInspectBrk(split.nodeFlags);
  const restArgs = split.restArgs;

  let values: ReturnType<typeof parseCliArgs>["values"];
  try {
    values = parseCliArgs(restArgs).values;
  } catch (err) {
    die(err);
  }

  if (values.help) {
    console.log(help);
    process.exit(0);
  }

  if (values.version) {
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf-8"),
    );
    console.log(pkg.version);
    process.exit(0);
  }

  // Env for the child: always the sentinel; additionally flag that the user
  // asked for --inspect-brk so the child can pause right before importing
  // their script (Node's own --inspect-brk pauses too early — at cli.js:1).
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    _VITE_EXEC_CHILD: "1",
  };
  if (wantInspectBrk) childEnv._VITE_EXEC_INSPECT_BRK = "1";

  if (values.watch) {
    try {
      const { watchMode } = await import("./watch.js");
      await watchMode(nodeFlags, restArgs, childEnv);
    } catch (err) {
      die(err);
    }
    return;
  }

  // Non-watch: spawn one child, wait for it to exit, exit with its code.
  // Signal listeners installed before spawn so a signal arriving mid-spawn
  // still reaches the (soon-to-exist) child via the closure.
  let child: ChildProcess | undefined;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => child?.kill(sig));
  }

  const cliPath = fileURLToPath(import.meta.url);
  child = spawn(process.execPath, [...nodeFlags, cliPath, ...restArgs], {
    stdio: "inherit",
    env: childEnv,
  });

  child.on("error", (err) => {
    console.error(`[vite-exec] failed to spawn child: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    // POSIX signal exit: 128 + signal number. Otherwise mirror the child's code.
    if (signal) process.exit(128 + (osConstants.signals[signal] ?? 0));
    process.exit(code ?? 1);
  });
}
