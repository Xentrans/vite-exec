// Simulates the TypeORM CLI pattern: an externalized library (i.e. a file
// inside node_modules that Vite externalizes rather than transforming) that
// uses `Function("return s => import(s)")()` to call Node's native dynamic
// import() on a user-supplied path. Without the loader hook in src/loader.ts,
// this would fail with `Unknown file extension ".ts"` on a .ts target.
const runtimeImport = Function("return s => import(s)")();
const target = process.argv[2];
try {
  const mod = await runtimeImport(target);
  // Emit a compact single line the test can parse. Stringify named exports
  // along with the default so tests can assert on specific shapes.
  const keys = Object.keys(mod);
  const summary = keys.map((k) => {
    const v = mod[k];
    const type = typeof v;
    const ctor = v && typeof v === "object" ? v.constructor?.name : undefined;
    const marker = v && typeof v === "object" ? v.kind ?? v.id ?? v.name : v;
    return `${k}:${type}:${ctor ?? ""}:${marker ?? ""}`;
  }).join("|");
  console.log("EXT:" + summary);
} catch (err) {
  // Surface enough to let tests assert on both the message and (critically)
  // that .code survived structured-clone across the MessagePort.
  console.log("EXTERR:" + (err?.code ?? "") + ":" + (err?.message ?? err));
  process.exit(2);
}
