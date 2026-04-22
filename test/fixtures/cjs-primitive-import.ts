import primLib, { foo } from "./cjs-primitive.js";

console.log("default:", primLib);
console.log("foo:", typeof foo === "undefined" ? "undefined" : foo);
