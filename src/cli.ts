#!/usr/bin/env node

import { main } from "./run.js";
import { watchMode } from "./watch.js";

const args = process.argv.slice(2);
const isWatchMode = args.includes("--watch") || args.includes("-w");
const entry = isWatchMode ? watchMode(args) : main(args);
entry.catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
