import { parseArgs } from "node:util";

export const help = `
Usage: vite-exec [options] <file> [...args]
       vite-exec -e <code> [...args]

Run a JS/TS file (or inline code) through Vite's transform pipeline.

Options:
  -e, --eval <code>    Run inline code instead of a file
  -r, --require <mod>  Preload a module before running the script (repeatable)
  -w, --watch          Re-run the script when files change
      --ext <exts>     Extensions to watch, comma-separated (default: ts,js,mjs,mts,json)
  -i, --ignore <pat>   Ignore pattern for watch mode (repeatable)
  -d, --delay <ms>     Debounce delay in ms for watch restarts (default: 200)
      --clear          Clear screen before each restart
  -q, --quiet          Suppress [vite-exec] messages
      --verbose        Show diagnostic info
  -h, --help           Show this help message
  -v, --version        Show version
`.trim();

const cliOptions = {
  eval: { type: "string" as const, short: "e" },
  require: { type: "string" as const, short: "r", multiple: true, default: [] },
  watch: { type: "boolean" as const, short: "w", default: false },
  ext: { type: "string" as const },
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

function isEvalFlag(arg: string): boolean {
  // `-e=...` isn't standard Node/tsx syntax; leave it to parseArgs to handle.
  return arg === "-e" || arg === "--eval" || arg.startsWith("--eval=");
}

export function parseCliArgs(args: string[]) {
  // Split args: everything before the file (or --eval CODE) is for vite-exec,
  // everything after is forwarded to the script. An explicit `--` also works
  // as a separator before a file.
  //
  // Examples:
  //   vite-exec --verbose script.ts --port 3000
  //   vite-exec -r dotenv/config script.ts --port 3000
  //   vite-exec script.ts -- --flag         (-- is forwarded to the script)
  //   vite-exec -e "code" --port 3000       (--port is forwarded)
  //   vite-exec -e "code" arg1 arg2         (positionals forwarded)

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
    // After consuming `-e CODE` / `--eval CODE` / `--eval=CODE`, everything
    // that follows is forwarded to the script (matches Node's `-e` convention).
    if (isEvalFlag(arg)) {
      forwardedArgs = args.slice(i + 1);
      break;
    }
  }

  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: cliOptions,
    allowPositionals: true,
  });

  return { values, positionals, forwardedArgs };
}

export function buildChildArgs(args: string[]): string[] {
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
