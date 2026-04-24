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

# Inline eval
npx vite-exec -e "console.log('hi')"

# Preload a module (like node -r)
npx vite-exec -r dotenv/config script.ts

# Watch mode — re-runs on file changes
npx vite-exec --watch script.ts

# Watch only specific extensions
npx vite-exec -w --ext ts,json script.ts

# Watch with custom ignore patterns (glob, repeatable) and delay
npx vite-exec -w -i "**/*.test.ts" -d 500 script.ts

# Clear screen before each restart
npx vite-exec -w --clear script.ts

# Forward a Node flag (anything unrecognised before the file goes to node)
npx vite-exec --inspect script.ts
npx vite-exec --enable-source-maps --stack-trace-limit=20 script.ts

# Enable verbose output
npx vite-exec --verbose script.ts
```

During watch mode, type `rs` + Enter to manually restart.

## CLI Flags

| Flag | Description |
|---|---|
| `-e, --eval <code>` | Run inline code instead of a file |
| `-r, --require <mod>` | Preload a module before running the script (repeatable) |
| `-w, --watch` | Re-run the script when files change |
| `    --ext <exts>` | Extensions to watch, comma-separated (default: `ts,js,mjs,mts,json`) |
| `-i, --ignore <pat>` | Ignore glob for watch mode, relative to cwd (repeatable). Built-in: `node_modules`, `.git`, `dist`, `coverage`, etc. |
| `-d, --delay <ms>` | Debounce delay in ms for watch restarts (default: 200) |
| `--clear` | Clear screen before each restart |
| `-q, --quiet` | Suppress `[vite-exec]` messages |
| `--verbose` | Show diagnostic info |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

Any flag before the file that isn't in the table above is treated as a Node
flag and forwarded — `--inspect`, `--enable-source-maps`,
`--max-old-space-size=4096`, `--stack-trace-limit=50`, etc. Node flags that
take a value must use the `--flag=value` form.

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

`vite-exec` always runs your script in a **child Node process**:

1. The parent parses argv — anything before the file that isn't a vite-exec
   flag is treated as a Node flag (`--inspect`, `--enable-source-maps`, etc.)
2. It spawns `node [...node flags] vite-exec-entry [...vite-exec args]` and
   forwards stdio, signals, and exit code
3. The child initialises a standalone Vite `RunnableDevEnvironment` with a
   `ModuleRunner`, transforms your file via Vite's plugin pipeline
   (TypeScript, JSX, etc.), and runs it on Node.js
4. Child exits → parent mirrors the exit code (or `128 + signal` for signal
   exits)

In watch mode the parent becomes a supervisor — it runs chokidar and
respawns a fresh child on each change, so side effects (open handles,
timers, listeners) don't leak across restarts.

The parent/child split is what makes Node flag passthrough work cleanly:
the watcher (parent) stays clean, and Node flags apply only to the child
where your script actually runs.

## Debugging

`--inspect` and `--inspect-brk` are forwarded to Node like any other Node
flag. `--inspect-brk` pauses at the first line of your script rather than
at vite-exec's entry, so breakpoints can be set before your code runs.

## Comparison with other runners

| | vite-exec | tsx | ts-node |
|---|---|---|---|
| Engine | Vite | esbuild | TypeScript compiler |
| Vite plugin support | ✓ | | |
| TypeScript paths from `tsconfig.json` | ✓ | ✓ | ✓ |
| `emitDecoratorMetadata` (e.g. TypeORM) | ✓ | | ✓ |
| Tools that dynamically `import()` your `.ts` files (e.g. TypeORM CLI) | ✓ | | |
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
- You want tools like the TypeORM or Vitest CLIs to be able to import your
  `.ts` source files directly. vite-exec installs a Node loader hook that
  routes native `import()` of `.ts` paths back through Vite's ModuleRunner,
  so e.g. `typeorm migration:generate -d src/dataSource.ts` works without a
  prior `tsc` build.
- You want scripts to see the same Vite plugins and resolver config as your app.

**tsx** is probably the right default otherwise: it's faster to start, more
mature, and has features we don't (REPL, piped stdin).

**ts-node** emits decorator metadata but its ESM support has been shaky, and
the project is less actively maintained at the moment.

## Requirements

- Node.js >= 20.0.0
- Vite >= 8.0.0

## License

MIT
