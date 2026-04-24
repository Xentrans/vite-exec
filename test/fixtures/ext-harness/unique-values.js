// Imports a .ts target and reports how many distinct values the namespace
// exposes across its enumerable keys — mimics TypeORM's migration loader
// iterating `Object.keys(mod)` and collecting each key's value into a set.
// If the loader-hook stub attaches a named-export sibling that's identity-
// equal to the default, it would double-count here.
const runtimeImport = Function("return s => import(s)")();
const target = process.argv[2];
const mod = await runtimeImport(target);
const keys = Object.keys(mod);
const distinct = new Set();
for (const k of keys) {
  if (mod[k] != null) distinct.add(mod[k]);
}
console.log(`UNIQ:keys=${keys.length}:distinct=${distinct.size}`);
