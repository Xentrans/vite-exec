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

// Subset of ESM globals injected into every module's scope so that scripts
// written against Node's CommonJS conventions (import * of user scripts using
// __dirname, __filename, or require) run without modification. Matches the
// pattern Vitest uses in its module evaluator. Skips `module`/`exports` because
// bridging CJS export assignment to ESM export semantics is fragile and the
// common case for entry-point scripts doesn't need it.
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
    );
    Object.seal(context[ssrModuleExportsKey]);
  }

  runExternalModule(filepath: string): Promise<unknown> {
    return import(filepath);
  }
}
