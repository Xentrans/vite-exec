// ESM loader hook installed via `module.register` from run.ts. For any native
// `import()` of a .ts/.tsx/.mts/.cts file (e.g. TypeORM's CLI doing
// `Function("return s => import(s)")()` on a user-supplied data source path),
// this hook delegates the actual transform + evaluation to the main-thread
// Vite ModuleRunner over a MessagePort, and returns a tiny CJS stub that
// reads pre-computed exports out of `globalThis.__vite_exec_modules`.
//
// The payoff of delegating to the ModuleRunner — rather than running our own
// oxc transform inside the hook — is that we inherit CJSModuleEvaluator's
// execution semantics for free: no TDZ on circular imports, no strict
// named-export check, and whatever decorator-metadata handling Vite picks up
// from the user's tsconfig.
import type { MessagePort } from "node:worker_threads";

type SerialisedError =
  | { __viteExecError: true; name: string; message: string; stack: string | undefined; own: Record<string, unknown> }
  | { __viteExecError: false; value: string };

type MainReply =
  | { id: number; ok: true; names: string[] }
  | { id: number; error: SerialisedError };

function hydrate(err: SerialisedError): unknown {
  if (!err.__viteExecError) return err.value;
  const e = new Error(err.message);
  e.name = err.name;
  if (err.stack !== undefined) e.stack = err.stack;
  // Restore custom own properties (.code, .cause, and anything else the
  // thrower attached). Skip the keys Error's constructor already set so we
  // don't clobber them.
  for (const [k, v] of Object.entries(err.own)) {
    if (k === "message" || k === "name" || k === "stack") continue;
    (e as unknown as Record<string, unknown>)[k] = v;
  }
  return e;
}

const TS_EXT = /\.(ts|tsx|mts|cts)(\?|$)/;
const SAFE_ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

let port: MessagePort | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (names: string[]) => void; reject: (err: unknown) => void }>();

export function initialize(data: { port: MessagePort }): void {
  port = data.port;
  port.on("message", (msg: MainReply) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if ("ok" in msg) p.resolve(msg.names);
    else p.reject(hydrate(msg.error));
  });
  // If the main thread closes the port (e.g. environment.close() during a
  // graceful shutdown), any still-pending requests would otherwise hang
  // forever. Reject them so Node can propagate a sensible error up through
  // the caller's `import()`.
  port.on("close", () => {
    const err = new Error("vite-exec loader: port closed before reply");
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  });
}

function requestMainImport(url: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    if (!port) {
      reject(new Error("vite-exec loader: MessagePort not initialised"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ id, url });
  });
}

// Names like "default-export" or keys containing punctuation can't appear as
// dotted accessors; fall back to bracket notation with a JSON-quoted key.
function member(target: string, name: string): string {
  return SAFE_ID.test(name)
    ? `${target}.${name}`
    : `${target}[${JSON.stringify(name)}]`;
}

export async function load(
  url: string,
  context: import("node:module").LoadHookContext,
  nextLoad: (url: string, context?: Partial<import("node:module").LoadHookContext>) => import("node:module").LoadFnOutput | Promise<import("node:module").LoadFnOutput>,
): Promise<import("node:module").LoadFnOutput> {
  if (!url.startsWith("file://") || !TS_EXT.test(url)) {
    return nextLoad(url, context);
  }
  const names = await requestMainImport(url);
  const urlJson = JSON.stringify(url);
  // The stub runs exactly once per URL — Node's CJS loader caches the
  // evaluated module and short-circuits all subsequent imports, so our hook
  // and this stub never fire again for the same URL. That means the Map
  // entry is dead storage after this read: delete it so long-lived hosts
  // (e.g. a web server that dynamically imports .ts request handlers) don't
  // accumulate references over their lifetime. `m` still holds a live ref
  // to the module object while the assignments below copy its exports.
  const lines = [
    `const m = globalThis.__vite_exec_modules.get(${urlJson});`,
    `if (!m) throw new Error("vite-exec: module not loaded via runner: " + ${urlJson});`,
    `globalThis.__vite_exec_modules.delete(${urlJson});`,
  ];
  // Node's CJS→ESM interop wraps `exports.default = X` as `mod.default = { default: X }`
  // (two levels deep). Downstream consumers like TypeORM's `InstanceChecker.isDataSource`
  // read `mod.default` directly and fail against the wrapper. Assigning
  // `module.exports = m.default` sidesteps the wrapper — Node treats a raw
  // `module.exports = X` as the unwrapped default.
  //
  // When both default and named exports coexist, we attach the named siblings
  // as own properties of the default value so lexer-detected names work.
  // This only works when the default is a non-frozen object/function; for
  // primitives, null, or frozen objects we fall back to the `exports.default =
  // …` path (which double-wraps default, but TypeORM's pattern doesn't hit
  // those cases — nobody has `export default 42` as a data source).
  const nonDefault = names.filter((n) => n !== "default");
  if (names.includes("default")) {
    const mutationTarget = nonDefault.length > 0;
    if (mutationTarget) {
      lines.push(`const __d = m.default;`);
      lines.push(
        `if (__d != null && (typeof __d === "object" || typeof __d === "function") && Object.isExtensible(__d)) {`,
      );
      lines.push(`  module.exports = __d;`);
      for (const n of nonDefault) {
        lines.push(`  ${member("module.exports", n)} = ${member("m", n)};`);
      }
      lines.push(`} else {`);
      lines.push(`  exports.default = __d;`);
      for (const n of nonDefault) {
        lines.push(`  ${member("exports", n)} = ${member("m", n)};`);
      }
      lines.push(`}`);
    } else {
      lines.push(`module.exports = m.default;`);
    }
  } else {
    for (const n of names) {
      lines.push(`${member("exports", n)} = ${member("m", n)};`);
    }
  }
  return {
    format: "commonjs",
    source: lines.join("\n") + "\n",
    shortCircuit: true,
  };
}
