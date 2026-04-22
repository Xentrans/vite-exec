import { createRequire } from "node:module";
import {
  ESModulesEvaluator,
  ssrDynamicImportKey,
  ssrExportAllKey,
  ssrExportNameKey,
  ssrImportKey,
  ssrImportMetaKey,
  ssrModuleExportsKey,
  type ModuleEvaluator,
  type ModuleRunnerContext,
} from "vite/module-runner";

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;

type ExportsObject = Record<string | symbol, unknown>;

function isPrimitive(v: unknown): boolean {
  return (typeof v !== "object" && typeof v !== "function") || v == null;
}

// Defines an enumerable getter on the exports object. Using a getter lets us
// re-export live bindings in the same way Vite's __vite_ssr_exportName__ does.
function defineExport(
  exports: ExportsObject,
  key: string | symbol,
  getter: () => unknown,
): void {
  Object.defineProperty(exports, key, {
    enumerable: true,
    configurable: true,
    get: getter,
  });
}

// Copies enumerable named keys from a CJS module.exports value onto the ESM
// exports namespace, so that `import { foo } from "cjs-module"` works after
// `module.exports = { foo }`. Skips `default` (handled separately), arrays,
// primitives, and promises — matches Vitest's semantics.
function exportAll(exports: ExportsObject, source: unknown): void {
  if (exports === source) return;
  if (isPrimitive(source) || Array.isArray(source) || source instanceof Promise) return;
  const src = source as Record<string, unknown>;
  for (const key in src) {
    if (key === "default") continue;
    if (key in exports) continue;
    try {
      defineExport(exports, key, () => src[key]);
    } catch {
      // Some keys may throw on access (e.g. getters that error). Skip them
      // rather than aborting the whole export.
    }
  }
}

// Builds the `module` and `exports` globals that user code will see. They
// share state with Vite's ESM exports namespace (`context[ssrModuleExportsKey]`)
// so CJS assignments translate cleanly into ESM default + named exports.
//
// Semantics match Node.js CJS/ESM interop:
//   module.exports = X     → default = X, named exports = enumerable keys of X
//   exports.foo = X        → named export `foo` = X, and default.foo = X
//   module.exports = 42    → default = 42, no named exports (primitive)
//
// Caveat: reading `module.exports` inside the script returns the proxy, not
// the raw value that was assigned. This differs from Node CJS but is
// necessary so that later `exports.foo` assignments still reach the ESM
// namespace. The common case (assign once, let it be imported) is unaffected.
function createCJSGlobals(exportsObject: ExportsObject) {
  const cjsExports = new Proxy(exportsObject, {
    get: (target, p, receiver) =>
      Reflect.has(target, p)
        ? Reflect.get(target, p, receiver)
        : Reflect.get(Object.prototype, p, receiver),
    getPrototypeOf: () => Object.prototype,
    set: (_, p, value) => {
      // `exports.default = X` is treated like `module.exports = X` to avoid
      // producing nested `default.default` shapes when interop kicks in.
      if (p === "default" && !isPrimitive(value) && cjsExports !== value) {
        exportAll(cjsExports, value);
        exportsObject.default = value;
        return true;
      }
      // Ensure `default` exists so CJS consumers can still destructure from it.
      if (!Reflect.has(exportsObject, "default")) {
        exportsObject.default = {};
      }
      // Mirror the assignment onto `default` so that `import x from ...` also
      // sees the property (Node's CJS-imported-as-ESM convention).
      if (p !== "default" && !isPrimitive(exportsObject.default)) {
        (exportsObject.default as Record<string, unknown>)[p as string] = value;
      }
      if (p !== "default") {
        defineExport(exportsObject, p, () => value);
      }
      return true;
    },
  });

  const moduleProxy = {
    get exports() {
      return cjsExports;
    },
    set exports(value: unknown) {
      exportAll(cjsExports, value);
      exportsObject.default = value;
    },
  };

  return { cjsExports, moduleProxy };
}

// Custom evaluator that injects Node CJS globals into every module's scope:
// __dirname, __filename, require (always usable) and module/exports (which
// bridge to Vite's ESM export namespace). Scripts written against Node CJS
// conventions run without modification; files meant for ESM import still work
// because the bridge layers both sets of semantics onto the same namespace.
export class CJSModuleEvaluator implements ModuleEvaluator {
  // AsyncFunction's declaration takes exactly one line regardless of parameter
  // count, so the padding offset from ESModulesEvaluator applies unchanged.
  startOffset = new ESModulesEvaluator().startOffset;

  async runInlinedModule(
    context: ModuleRunnerContext,
    code: string,
  ): Promise<void> {
    const meta = context[ssrImportMetaKey];
    const require = createRequire(meta.url);
    const { cjsExports, moduleProxy } = createCJSGlobals(
      context[ssrModuleExportsKey],
    );
    await new AsyncFunction(
      ssrModuleExportsKey,
      ssrImportMetaKey,
      ssrImportKey,
      ssrDynamicImportKey,
      ssrExportAllKey,
      ssrExportNameKey,
      "__dirname",
      "__filename",
      "require",
      "module",
      "exports",
      `"use strict";${code}`,
    )(
      context[ssrModuleExportsKey],
      context[ssrImportMetaKey],
      context[ssrImportKey],
      context[ssrDynamicImportKey],
      context[ssrExportAllKey],
      context[ssrExportNameKey],
      meta.dirname,
      meta.filename,
      require,
      moduleProxy,
      cjsExports,
    );
    Object.seal(context[ssrModuleExportsKey]);
  }

  runExternalModule(filepath: string): Promise<unknown> {
    return import(filepath);
  }
}
