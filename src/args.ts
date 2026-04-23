import { parseArgs } from "node:util";

export const help = `
Usage: vite-exec [node-flags] [vite-exec options] <file> [...args]
       vite-exec [node-flags] -e <code> [...args]

Run a JS/TS file (or inline code) through Vite's transform pipeline.
Any unrecognised flag before the file is forwarded to Node (e.g.
--inspect, --enable-source-maps, --stack-trace-limit=50). Node flags
that take values must use the =value form.

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
  return (
    arg === "-e" ||
    arg === "--eval" ||
    arg.startsWith("--eval=") ||
    arg.startsWith("-e=")
  );
}

// Is this flag one that vite-exec itself handles? Anything else that looks
// like a flag (starts with `-`) and appears before the first positional is
// treated as a Node flag and forwarded to the child's node invocation.
function isOurFlag(arg: string): boolean {
  if (arg.startsWith("--")) {
    const name = arg.slice(2).split("=")[0];
    return name in cliOptions;
  }
  // Short form (e.g. -w, -wq). A cluster is ours iff every char maps to
  // one of our short flags.
  const chars = arg.slice(1).split("=")[0];
  if (chars.length === 0) return false;
  return [...chars].every((c) => shortFlagMap.has(c));
}

// Translate --inspect-brk to --inspect so Node doesn't pause at our CLI's
// first line (which is never useful — user code hasn't loaded yet). The
// child uses the returned `wantInspectBrk` to call inspector.waitForDebugger()
// immediately before importing the user's script, making the break point
// land on the user's first line as they'd expect.
export function translateInspectBrk(nodeFlags: string[]): {
  nodeFlags: string[];
  wantInspectBrk: boolean;
} {
  let wantInspectBrk = false;
  const translated = nodeFlags.map((flag) => {
    if (flag === "--inspect-brk") {
      wantInspectBrk = true;
      return "--inspect";
    }
    if (flag.startsWith("--inspect-brk=")) {
      wantInspectBrk = true;
      return `--inspect=${flag.slice("--inspect-brk=".length)}`;
    }
    return flag;
  });
  return { nodeFlags: translated, wantInspectBrk };
}

// Separate Node flags from everything else. The parent passes `nodeFlags`
// to the child's `node` invocation; `restArgs` becomes the child's argv
// (vite-exec flags + positional + forwarded script args), ready for
// parseCliArgs.
//
// Grammar assumption: Node flags that take a value must use `--flag=value`
// form. The space-separated form (`--stack-trace-limit 50`) can't be
// supported without enumerating every Node flag, which is what we're
// trying to avoid.
export function splitArgs(args: string[]): {
  nodeFlags: string[];
  restArgs: string[];
} {
  const nodeFlags: string[] = [];
  const restArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // `--` or first positional — hand the rest (file + script args) to the child.
    if (arg === "--" || !arg.startsWith("-")) {
      restArgs.push(...args.slice(i));
      break;
    }

    if (!isOurFlag(arg)) {
      nodeFlags.push(arg);
      continue;
    }

    // Short flag with equals (e.g. -e=CODE): parseArgs doesn't parse this
    // form natively for short options, so split into -e + CODE.
    const isShortWithEquals = !arg.startsWith("--") && arg.includes("=");
    if (isShortWithEquals) {
      const eqIdx = arg.indexOf("=");
      restArgs.push(arg.slice(0, eqIdx), arg.slice(eqIdx + 1));
    } else {
      restArgs.push(arg);
      if (optionTakesValue(arg) && i + 1 < args.length) {
        restArgs.push(args[++i]);
      }
    }

    // After `-e CODE` / `-e=CODE` / `--eval=CODE`, everything else is
    // forwarded script argv.
    if (isEvalFlag(arg)) {
      restArgs.push(...args.slice(i + 1));
      break;
    }
  }

  return { nodeFlags, restArgs };
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
  // runs the script directly instead of re-entering watch mode and
  // forking forever.
  const { values, positionals, forwardedArgs } = parseCliArgs(args);
  const childArgs: string[] = [];

  for (const mod of values.require ?? []) {
    childArgs.push("-r", mod);
  }
  if (values.verbose) childArgs.push("--verbose");

  childArgs.push(...positionals, ...forwardedArgs);

  return childArgs;
}
