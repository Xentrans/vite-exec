import greeter from "./cjs-module.js";
import { greet, version } from "./cjs-module.js";
import { add, sub } from "./cjs-named.js";

console.log("default:", greeter.greet("world"), greeter.version);
console.log("named:", greet("world"), version);
console.log("math:", add(2, 3), sub(10, 4));
