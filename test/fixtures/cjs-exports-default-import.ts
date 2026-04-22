// Runtime exports are defined by our CJS bridge; TS can't see them.
// @ts-expect-error — named imports bridged at runtime
import mod, { hello, version } from "./cjs-exports-default.js";

const m = mod as unknown as { hello: string; version: string };
console.log("default:", m.hello, m.version);
console.log("named:", hello, version);
