// Two successive native import()s of the same .ts URL. Asserts Node caches
// the loader-hook output so our Map.delete() in the stub is safe — if Node
// re-invoked the hook per import, the second call would still work (main
// thread re-populates) but users would see a different namespace instance.
const runtimeImport = Function("return s => import(s)")();
const target = process.argv[2];
const m1 = await runtimeImport(target);
const m2 = await runtimeImport(target);
const sameNs = m1 === m2;
const sameDefault = m1.default === m2.default;
console.log(`DOUBLE:ns=${sameNs}:default=${sameDefault}`);
