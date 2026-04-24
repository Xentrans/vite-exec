// Mimics a TypeORM migration file: single class, named export only, no
// default. The regression being guarded is that TypeORM's migration loader
// recursively walks `Object.values(namespace)`, and Node's CJS→ESM interop
// (without an __esModule marker) would expose both `mod.default =
// module.exports` and `mod.SomeMig = <class>`, causing the loader to find
// the same class twice.
export class SomeMig1234 {
  static readonly kind = "MIG";
}
