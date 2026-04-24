import { A } from "./circular-a.js";

export class B {
  partner: typeof A | undefined;
}

console.log("circular-b loaded, A=" + typeof A);
