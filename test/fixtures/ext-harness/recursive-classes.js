// Mirrors TypeORM's DirectoryExportedClassesLoader.loadFileClasses — it
// recursively descends into objects via Object.values and collects every
// function it finds. Our loader-hook stub must not let the same class
// appear under multiple keys of the imported namespace, or TypeORM would
// register each migration twice.
const runtimeImport = Function("return s => import(s)")();
const target = process.argv[2];
const mod = await runtimeImport(target);
const seen = [];
function walk(value) {
  if (typeof value === "function") seen.push(value);
  else if (Array.isArray(value)) value.forEach(walk);
  else if (value != null && typeof value === "object") Object.values(value).forEach(walk);
}
walk(mod);
const unique = new Set(seen);
console.log(`RECURSIVE:found=${seen.length}:unique=${unique.size}`);
