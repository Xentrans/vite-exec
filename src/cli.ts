#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve, relative } from "node:path";
import { accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, isRunnableDevEnvironment } from "vite";
import type { ViteDevServer } from "vite";

const help = `
Usage: vite-exec [options] <file> [-- ...args]

Run a JS/TS file through Vite's transform pipeline.

Options:
  -c, --config <path>  Path to a Vite config file
      --root <path>    Project root directory
      --verbose        Show Vite logs and diagnostic info
  -h, --help           Show this help message
  -v, --version        Show version
`.trim();

async function getVersion(): Promise<string> {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf-8"),
  );
  return pkg.version as string;
}

async function getViteVersion(): Promise<string> {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const vitePkgPath = require.resolve("vite/package.json");
  const pkg = JSON.parse(await readFile(vitePkgPath, "utf-8"));
  return pkg.version as string;
}

function parseCliArgs(args: string[]) {
  // Split on -- to separate our flags from forwarded args
  const ddIndex = args.indexOf("--");
  const ownArgs = ddIndex === -1 ? args : args.slice(0, ddIndex);
  const forwardedArgs = ddIndex === -1 ? [] : args.slice(ddIndex + 1);

  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: {
      config: { type: "string", short: "c" },
      root: { type: "string" },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  return { values, positionals, forwardedArgs };
}

let server: ViteDevServer | undefined;

function registerSignalHandlers() {
  const handler = async (signal: string) => {
    if (server) {
      await server.close();
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

async function main() {
  const { values, positionals, forwardedArgs } = parseCliArgs(
    process.argv.slice(2),
  );

  if (values.help) {
    console.log(help);
    process.exit(0);
  }

  if (values.version) {
    console.log(await getVersion());
    process.exit(0);
  }

  const filePath = positionals[0];
  if (!filePath) {
    console.error("Error: No file specified.\n");
    console.error(help);
    process.exit(1);
  }

  const root = values.root ? resolve(process.cwd(), values.root) : process.cwd();
  const resolvedPath = resolve(process.cwd(), filePath);

  try {
    accessSync(resolvedPath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const verbose = values.verbose ?? false;
  const configPath = values.config
    ? resolve(process.cwd(), values.config)
    : false;

  if (verbose) {
    const version = await getVersion();
    const viteVersion = await getViteVersion();
    const displayConfig = configPath
      ? relative(process.cwd(), configPath) || configPath
      : "(none)";
    const displayRoot = relative(process.cwd(), root) || ".";
    const displayScript = relative(process.cwd(), resolvedPath) || resolvedPath;

    console.error(`vite-exec v${version} | vite v${viteVersion}`);
    console.error(`Config: ${displayConfig}`);
    console.error(`Root:   ${displayRoot}`);
    console.error(`Script: ${displayScript}`);
    console.error("---");
  }

  registerSignalHandlers();

  server = await createServer({
    configFile: configPath,
    root,
    logLevel: verbose ? "info" : "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true },
  });

  const ssr = server.environments.ssr;

  if (!isRunnableDevEnvironment(ssr)) {
    console.error(
      "Error: SSR environment is not runnable.\n" +
        "If using --config, your config may override the SSR environment to a non-runnable type.",
    );
    await server.close();
    process.exit(1);
  }

  // Rewrite process.argv so the script sees the forwarded args
  process.argv = [process.execPath, resolvedPath, ...forwardedArgs];

  try {
    await ssr.runner.import(resolvedPath);
  } catch (err) {
    if (verbose && err instanceof Error) {
      console.error(err);
    } else if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error:", err);
    }
    await server.close();
    process.exit(1);
  }

  await server.close();
  process.exit(0);
}

main();
