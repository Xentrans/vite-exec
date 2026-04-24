// Regression fixture: a single class is exported as both the default AND
// under its own name. Mimics the `export default class Foo {}` pattern that
// TypeORM migration files commonly use (the class name may leak out as a
// named export depending on toolchain). Consumers iterating the namespace —
// TypeORM's migration loader being the canonical example — must not see
// the class twice.
class FooMigration {
  static readonly kind = "MIG";
}
export { FooMigration };
export default FooMigration;
