# vite-exec

Run JS/TS files through Vite's transform pipeline — a modern replacement for
[vite-node](https://github.com/antfu-collective/vite-node).

Uses Vite's built-in [Environment API](https://vite.dev/guide/api-environment)
and `ModuleRunner` instead of the separate `vite-node` package. No dev server,
no WebSocket, no HMR — just transform and execute.

## Installation

```bash
npm install -D vite-exec vite
```

`vite` is a peer dependency — you need it installed in your project.

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

## Differences from vite-node

| | vite-exec | vite-node |
|---|---|---|
| **Vite API** | Built-in `ModuleRunner` | Custom ViteNodeServer/ViteNodeRunner |
| **Server** | No dev server | Full Vite dev server |
| **Dependencies** | Only `vite` (peer dep) | `vite-node` package + internals |
| **Vite version** | Requires Vite 8+ | Works with older Vite versions |
| **Config** | None (clean environment) | Loads vite.config by default |
| **Maintenance** | Uses stable Vite APIs | Recommends migrating to Environment API |

## Requirements

- Node.js >= 20.0.0
- Vite >= 8.0.0

## License

MIT
