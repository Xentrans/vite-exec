# vite-exec

A CLI for running TS/JS files through Vite. Similar to
[tsx](https://github.com/privatenumber/tsx) or
[ts-node](https://github.com/TypeStrong/ts-node), but powered by Vite's
[`ModuleRunner`](https://vite.dev/guide/api-environment-runtimes) — your scripts
see the same transforms, plugins, and resolver as your Vite app.

## Installation

```bash
npm install -D vite-exec
```

## Usage

```bash
# Run a TypeScript file
npx vite-exec script.ts

# Forward arguments to the script (everything after the file)
npx vite-exec script.ts --port 3000

# Preload a module (like node -r)
npx vite-exec -r dotenv/config script.ts

# Watch mode — re-runs on file changes
npx vite-exec --watch script.ts

# Watch only specific extensions
npx vite-exec -w -e ts,json script.ts

# Watch with custom ignore patterns and delay
npx vite-exec -w -i "*.test.ts" -d 500 script.ts

# Clear screen before each restart
npx vite-exec -w --clear script.ts

# Enable verbose output
npx vite-exec --verbose script.ts
```

During watch mode, type `rs` + Enter to manually restart.

## CLI Flags

| Flag | Description |
|---|---|
| `-r, --require <mod>` | Preload a module before running the script (repeatable) |
| `-w, --watch` | Re-run the script when files change |
| `-e, --ext <exts>` | Extensions to watch, comma-separated (default: `ts,js,mjs,mts,json`) |
| `-i, --ignore <pat>` | Ignore pattern for watch mode (repeatable) |
| `-d, --delay <ms>` | Debounce delay in ms for watch restarts (default: 200) |
| `--clear` | Clear screen before each restart |
| `-q, --quiet` | Suppress `[vite-exec]` messages |
| `--verbose` | Show diagnostic info |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## TypeScript Path Aliases

`vite-exec` automatically resolves path aliases from your `tsconfig.json`:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  }
}
```

```ts
// script.ts — just works
import { db } from "@/lib/database";
```

Powered by Vite's built-in `resolve.tsconfigPaths` option.

## How it works

1. Resolves a minimal Vite config (no config file loaded)
2. Creates a standalone `RunnableDevEnvironment` with a `ModuleRunner`
3. Imports your file through the runner, which transforms it via Vite's plugin
   pipeline (TypeScript, JSX, etc.) and executes it on Node.js
4. Closes the environment and exits

## Comparison with other runners

| | vite-exec | tsx | ts-node |
|---|---|---|---|
| Engine | Vite | esbuild | TypeScript compiler |
| Vite plugin support | ✓ | | |
| TypeScript paths from `tsconfig.json` | ✓ | ✓ | ✓ |
| `emitDecoratorMetadata` (e.g. TypeORM) | ✓ | | ✓ |
| Type checking | | | optional |
| REPL | | ✓ | ✓ |
| Piped stdin | | ✓ | ✓ |
| Watch mode | ✓ | ✓ | |
| Inline eval (`-e`) | ✓ | ✓ | ✓ |

### When to use which

**vite-exec** is worth trying if:
- You use TypeORM or another library that relies on `emitDecoratorMetadata` +
  `experimentalDecorators`. tsx (esbuild-based) doesn't emit decorator metadata,
  so TypeORM entities lose their types at runtime. Vite's transformer handles it.
- You want scripts to see the same Vite plugins and resolver config as your app.

**tsx** is probably the right default otherwise: it's faster to start, more
mature, and has features we don't (REPL, piped stdin).

**ts-node** emits decorator metadata but its ESM support has been shaky, and
the project is less actively maintained at the moment.

## Debugging

vite-exec runs your script in a normal Node.js process, so Node's built-in
debugger works via the usual environment variable or CLI flag:

```bash
# Attach with Chrome DevTools / VS Code
NODE_OPTIONS=--inspect vite-exec script.ts

# Pause on first line
NODE_OPTIONS=--inspect-brk vite-exec script.ts

# Or via explicit node invocation
node --inspect ./node_modules/.bin/vite-exec script.ts
```

**In watch mode**, both the watcher process and the child inherit
`NODE_OPTIONS`, so they'll try to bind the same debugger port. Use a random
port to avoid the conflict:

```bash
NODE_OPTIONS=--inspect=0 vite-exec -w script.ts
```

Each restart will listen on a fresh port, printed to stderr. Attach to the
port reported after "change detected".

You can also open the inspector from inside your script:

```ts
import inspector from "node:inspector";
inspector.open(0);  // random port
console.log("debugger listening on", inspector.url());
```

## Requirements

- Node.js >= 20.0.0
- Vite >= 8.0.0

## License

MIT
