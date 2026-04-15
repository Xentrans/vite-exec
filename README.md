# vite-exec

Run JS/TS files through Vite's transform pipeline — a modern replacement for
[vite-node](https://github.com/antfu-collective/vite-node).

Uses Vite's built-in [Environment API](https://vite.dev/guide/api-environment)
and `ModuleRunner` (available since Vite 6) instead of the separate `vite-node`
package.

## Installation

```bash
npm install -D vite-exec vite
```

`vite` is a peer dependency — you need it installed in your project.

## Usage

```bash
# Run a TypeScript file
npx vite-exec script.ts

# Forward arguments to the script
npx vite-exec script.ts -- --port 3000

# Use a specific Vite config
npx vite-exec -c vite.config.ts script.ts

# Set the project root
npx vite-exec --root ./packages/app script.ts

# Enable verbose output (Vite logs + diagnostics)
npx vite-exec --verbose script.ts
```

## CLI Flags

| Flag | Description |
|---|---|
| `-c, --config <path>` | Path to a Vite config file (none loaded by default) |
| `--root <path>` | Project root directory |
| `--verbose` | Show Vite logs and diagnostic info |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## How it works

1. Creates a Vite dev server in middleware mode (no HTTP server, no WebSocket)
2. Accesses the SSR environment's `ModuleRunner`
3. Imports your file through the runner, which transforms it via Vite's plugin
   pipeline (TypeScript, JSX, etc.) and executes it on Node.js
4. Closes the server and exits

## Differences from vite-node

| | vite-exec | vite-node |
|---|---|---|
| **Vite API** | Built-in `ModuleRunner` | Custom ViteNodeServer/ViteNodeRunner |
| **Dependencies** | Only `vite` (peer dep) | `vite-node` package + internals |
| **Vite version** | Requires Vite 8+ | Works with older Vite versions |
| **Config loading** | No config by default | Loads vite.config by default |
| **Maintenance** | Uses stable Vite APIs | Recommends migrating to Environment API |

## Config loading

By default, `vite-exec` does **not** load a `vite.config.ts` file. This gives
scripts a clean, predictable environment. If you need Vite plugins, aliases, or
other config, pass `--config`:

```bash
npx vite-exec -c vite.config.ts script.ts
```

## Requirements

- Node.js >= 20.0.0
- Vite >= 8.0.0

## License

MIT
