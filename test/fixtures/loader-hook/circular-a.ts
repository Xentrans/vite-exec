import { B } from "./circular-b.js";

export class A {
  partner: typeof B | undefined;
}

// Side-effect that runs while circular init is still in flight — would throw
// "Cannot access 'B' before initialization" under strict ESM live-binding
// semantics, but works under the CJSModuleEvaluator the ModuleRunner uses.
console.log("circular-a loaded, B=" + typeof B);

export default new A();
