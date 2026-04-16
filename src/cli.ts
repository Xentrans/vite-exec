#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { accessSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  resolveConfig,
  createRunnableDevEnvironment,
  createServerModuleRunner,
  type RunnableDevEnvironment,
  type ServerModuleRunnerOptions,
} from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const help = `
Usage: vite-exec [options] <file> [-- ...args]

Run a JS/TS file through Vite's transform pipeline.

Options:
  -r, --require <mod>  Preload a module before running the script (repeatable)
      --verbose        Show diagnostic info
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
  const selfRequire = createRequire(import.meta.url);
  const vitePkgPath = selfRequire.resolve("vite/package.json");
  const pkg = JSON.parse(await readFile(vitePkgPath, "utf-8"));
  return pkg.version as string;
}

function parseCliArgs(args: string[]) {
  const ddIndex = args.indexOf("--");
  const ownArgs = ddIndex === -1 ? args : args.slice(0, ddIndex);
  const forwardedArgs = ddIndex === -1 ? [] : args.slice(ddIndex + 1);

  const { values, positionals } = parseArgs({
    args: ownArgs,
    options: {
      require: { type: "string", short: "r", multiple: true, default: [] },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: true,
  });

  return { values, positionals, forwardedArgs };
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

  const resolvedPath = resolve(process.cwd(), filePath);

  try {
    accessSync(resolvedPath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const verbose = values.verbose ?? false;

  if (verbose) {
    const version = await getVersion();
    const viteVersion = await getViteVersion();
    console.error(`vite-exec v${version} | vite v${viteVersion}`);
    console.error("---");
  }

  const config = await resolveConfig(
    {
      configFile: false,
      envDir: false,
      logLevel: verbose ? "info" : "silent",
      plugins: [tsconfigPaths()],
      environments: {
        exec: {
          consumer: "server",
          dev: { moduleRunnerTransform: true },
          resolve: { external: true, mainFields: [], conditions: ["node", "module-sync"] },
        },
      },
    },
    "serve",
  );

  const environment: RunnableDevEnvironment = createRunnableDevEnvironment(
    "exec",
    config,
    {
      runner(env: RunnableDevEnvironment, opts?: ServerModuleRunnerOptions) {
        const runner = createServerModuleRunner(env, {
          ...opts,
          hmr: { logger: false },
        });
        // Bypass strict named-export checking for externalized modules.
        // Vite's default processImport throws when a type-only export
        // (e.g. `import { Relation } from "typeorm"`) is imported without
        // the `type` keyword. Like Vitest, we relax this check.
        // @ts-expect-error processImport is private in Vite's types
        runner.processImport = (exports: Record<string, unknown>) => exports;
        return runner;
      },
      hot: false,
    },
  );

  await environment.init();

  process.argv = [process.execPath, resolvedPath, ...forwardedArgs];

  try {
    for (const mod of values.require ?? []) {
      if (mod.startsWith(".") || mod.startsWith("/")) {
        await environment.runner.import(resolve(process.cwd(), mod));
      } else {
        const cwdRequire = createRequire(
          pathToFileURL(resolve(process.cwd(), "noop.js")).href,
        );
        await import(cwdRequire.resolve(mod));
      }
    }
    await environment.runner.import(resolvedPath);
  } catch (err) {
    if (verbose && err instanceof Error) {
      console.error(err);
    } else if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error("Error:", err);
    }
    await environment.close();
    process.exit(1);
  }

  // Clean up the environment once the event loop drains, but don't
  // prevent Node from exiting naturally (unlike process.exit, this
  // lets pending promises, timers, and I/O complete first).
  process.on("beforeExit", () => environment.close());
}

main();
