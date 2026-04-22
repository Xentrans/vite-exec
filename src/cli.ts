#!/usr/bin/env node

import { parseCliArgs } from "./args.js";
import { main } from "./run.js";
import { watchMode } from "./watch.js";

const args = process.argv.slice(2);

// Parse once up front so dispatch sees the actual flag values, not raw argv
// (which would misroute e.g. `vite-exec -e "-w"` to watch mode because the
// string "-w" appears in argv). Wrapping in an async function lets both the
// synchronous parseCliArgs throws and the async entry rejections land in the
// same catch.
dispatch(args).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function dispatch(args: string[]): Promise<void> {
  const { values } = parseCliArgs(args);
  return values.watch ? watchMode(args) : main(args);
}
