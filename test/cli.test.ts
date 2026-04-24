import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURES = resolve(import.meta.dirname, "fixtures");

function run(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
  });
}

describe("vite-exec", () => {
  it("runs a TypeScript file and prints output", async () => {
    const { stdout, exitCode } = await run([`${FIXTURES}/hello.ts`]);
    assert.equal(stdout.trim(), "hello world");
    assert.equal(exitCode, 0);
  });

  it("passes -- through to the script", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/args.ts`,
      "--",
      "--port",
      "3000",
      "--verbose",
    ]);
    const args = JSON.parse(stdout.trim());
    assert.deepEqual(args, ["--", "--port", "3000", "--verbose"]);
    assert.equal(exitCode, 0);
  });

  it("forwards arguments after the file without requiring --", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/args.ts`,
      "--port",
      "3000",
    ]);
    const args = JSON.parse(stdout.trim());
    assert.deepEqual(args, ["--port", "3000"]);
    assert.equal(exitCode, 0);
  });

  it("consumes the value for a short flag that takes an argument", async () => {
    // -r <mod> must be recognized as flag + value (not two positionals);
    // the file path is the first non-flag arg after the value.
    const { stdout, exitCode } = await run([
      "-r",
      `${FIXTURES}/preload.ts`,
      `${FIXTURES}/args.ts`,
      "--port",
      "3000",
    ]);
    const args = JSON.parse(stdout.trim());
    assert.deepEqual(args, ["--port", "3000"]);
    assert.equal(exitCode, 0);
  });

  it("exits with code 1 when the script throws", async () => {
    const { exitCode, stderr } = await run([`${FIXTURES}/exit-code.ts`]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("intentional failure"));
  });

  it("supports top-level await", async () => {
    const { stdout, exitCode } = await run([`${FIXTURES}/async.ts`]);
    assert.equal(stdout.trim(), "async works");
    assert.equal(exitCode, 0);
  });

  it("prints usage and exits 1 when no file is specified", async () => {
    const { exitCode, stderr } = await run([]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("No file or --eval code specified"));
    assert.ok(stderr.includes("Usage:"));
  });

  it("prints error and exits 1 when file is not found", async () => {
    const { exitCode, stderr } = await run(["nonexistent.ts"]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("File not found"));
  });

  it("runs inline code with -e flag", async () => {
    const { stdout, exitCode } = await run(["-e", "console.log('hi from eval')"]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "hi from eval");
  });

  it("runs inline code with --eval long form", async () => {
    const { stdout, exitCode } = await run(["--eval", "console.log(2 + 3)"]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "5");
  });

  it("eval code sees cwd as __dirname and resolves relative imports from cwd", async () => {
    const { stdout, exitCode } = await run([
      "-e",
      "console.log(__dirname === process.cwd())",
    ]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "true");
  });

  it("forwards positional args to eval code via process.argv", async () => {
    const { stdout, exitCode } = await run([
      "-e",
      "console.log(JSON.stringify(process.argv.slice(2)))",
      "alpha",
      "beta",
    ]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout.trim()), ["alpha", "beta"]);
  });

  it("forwards flag-shaped args to eval code", async () => {
    const { stdout, exitCode } = await run([
      "-e",
      "console.log(JSON.stringify(process.argv.slice(2)))",
      "--port",
      "3000",
    ]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout.trim()), ["--port", "3000"]);
  });

  it("runs TypeScript syntax in eval code", async () => {
    const { stdout, exitCode } = await run([
      "-e",
      "const x: number = 42; console.log(x)",
    ]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "42");
  });

  it("forwards unrecognised flags before the file to Node", async () => {
    // --stack-trace-limit is a Node flag; vite-exec doesn't know it. It
    // should pass through and limit the error trace to 2 frames.
    const { stderr, exitCode } = await run([
      "--stack-trace-limit=2",
      `${FIXTURES}/exit-code.ts`,
    ]);
    assert.equal(exitCode, 1);
    // Count the `    at ` frames; should be 2.
    const frameLines = stderr.split("\n").filter((l) => l.startsWith("    at "));
    assert.equal(frameLines.length, 2);
  });

  it("unknown flags surface Node's 'bad option' error", async () => {
    const { stderr, exitCode } = await run([
      "--not-a-real-node-flag",
      `${FIXTURES}/hello.ts`,
    ]);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /bad option/);
  });

  it("--inspect passes through to Node (opens debugger)", async () => {
    // Port 0 so we don't clash with a real inspector on 9229. Check stderr
    // for either the success message or sandbox-failure message — either
    // one confirms Node received the flag.
    const { stderr } = await run(["--inspect=0", `${FIXTURES}/hello.ts`]);
    assert.match(stderr, /Debugger listening|Starting inspector/);
  });

  it("scrubs _VITE_EXEC_CHILD from env before user code runs", async () => {
    const { stdout, exitCode } = await run([
      "-e",
      "console.log(process.env._VITE_EXEC_CHILD ?? 'scrubbed')",
    ]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "scrubbed");
  });

  it("-e=CODE forwards subsequent flags to the script (not Node)", async () => {
    // Regression: before the fix, --custom would be treated as a Node flag
    // when the code arg used the -e=CODE form.
    const { stdout, exitCode } = await run([
      "-e=console.log(JSON.stringify(process.argv.slice(2)))",
      "--custom",
      "value",
    ]);
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout.trim()), ["--custom", "value"]);
  });

  it("mirrors SIGTERM exit as 128+15=143", async () => {
    const { exitCode } = await new Promise<{ exitCode: number }>((done) => {
      const child = execFile("node", [CLI, `${FIXTURES}/pending-async.ts`]);
      setTimeout(() => child.kill("SIGTERM"), 50);
      child.on("exit", (code, signal) => {
        // Parent forwards SIGTERM to the child, child exits with signal,
        // parent mirrors as 128+15.
        done({ exitCode: code ?? (signal ? 128 + 15 : 1) });
      });
    });
    assert.equal(exitCode, 143);
  });

  it("errors when --watch appears before --eval", async () => {
    // Flags after -e CODE become script args (per Node's -e convention),
    // so the only way --watch applies is when it appears BEFORE -e.
    const { exitCode, stderr } = await run(["-w", "-e", "x"]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("--eval cannot be combined with --watch"));
  });

  it("prints help with --help", async () => {
    const { stdout, exitCode } = await run(["--help"]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("Usage:"));
    assert.ok(stdout.includes("--verbose"));
  });

  it("prints version with --version", async () => {
    const { stdout, exitCode } = await run(["--version"]);
    assert.equal(exitCode, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  it("resolves tsconfig path aliases", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/alias-project/main.ts`,
    ]);
    assert.equal(stdout.trim(), "hello world");
    assert.equal(exitCode, 0);
  });

  it("preloads modules with -r flag", async () => {
    const { stdout, exitCode } = await run([
      "-r",
      `${FIXTURES}/preload.ts`,
      `${FIXTURES}/check-preload.ts`,
    ]);
    assert.equal(stdout.trim(), "preloaded: true");
    assert.equal(exitCode, 0);
  });

  it("injects CJS globals (__dirname, __filename, require)", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/cjs-globals.ts`,
    ]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("dirname: string"));
    assert.ok(stdout.includes("filename: string"));
    assert.ok(stdout.includes("require: function"));
    assert.ok(stdout.includes("sep: /"));
  });

  it("bridges module.exports and exports.x to ESM imports", async () => {
    const { stdout, exitCode } = await run([`${FIXTURES}/cjs-import.ts`]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("default: hello world 1.0"));
    assert.ok(stdout.includes("named: hello world 1.0"));
    assert.ok(stdout.includes("math: 5 6"));
  });

  it("matches Node CJS: primitive module.exports yields undefined named exports", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/cjs-primitive-import.ts`,
    ]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("default: 42"));
    assert.ok(stdout.includes("foo: undefined"));
  });

  it("mirrors exports.foo onto the default import", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/cjs-default-mirror-import.ts`,
    ]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("default.foo: bar"));
    assert.ok(stdout.includes("default.num: 42"));
  });

  it("treats exports.default = X like module.exports = X", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/cjs-exports-default-import.ts`,
    ]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("default: world 2.0"));
    assert.ok(stdout.includes("named: world 2.0"));
  });

  it("handles array module.exports without copying indices as named exports", async () => {
    const { stdout, exitCode } = await run([`${FIXTURES}/cjs-array-import.ts`]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes('default: ["a","b","c"]'));
    assert.ok(stdout.includes("isArray: true"));
  });

  it("handles type-only re-exports without the type keyword", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/type-export/main.ts`,
    ]);
    assert.equal(stdout.trim(), "alice");
    assert.equal(exitCode, 0);
  });

  it("waits for pending async work to complete", async () => {
    const { stdout, exitCode } = await run([
      `${FIXTURES}/pending-async.ts`,
    ]);
    assert.ok(stdout.includes("start"));
    assert.ok(stdout.includes("done"));
    assert.equal(exitCode, 0);
  });

  it("prints diagnostic info with --verbose", async () => {
    const { stdout, stderr, exitCode } = await run([
      "--verbose",
      `${FIXTURES}/hello.ts`,
    ]);
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), "hello world");
    assert.ok(stderr.includes("vite-exec v"));
    assert.ok(stderr.includes("vite v"));
  });
});

// These tests exercise the loader hook that routes native `import(".ts")`
// calls from externalized libraries (e.g. TypeORM's CLI) back through the
// ModuleRunner. ext-harness/index.js simulates the pattern by doing
// `Function("return s => import(s)")()(path)` — without the hook this would
// fail with `Unknown file extension ".ts"`.
describe("loader hook for externalized imports", () => {
  const EXT_HARNESS = `${FIXTURES}/ext-harness/index.js`;
  const TARGET = (name: string) => `${FIXTURES}/loader-hook/${name}`;

  it("exposes a .ts default export as mod.default directly (not double-wrapped)", async () => {
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("default-export.ts")]);
    assert.equal(exitCode, 0);
    // default is an object with kind="DS"; the "marker" field in ext-harness
    // picks up the .kind. If default were double-wrapped, ctor would be
    // "Object" but marker would be missing (kind would live one level deeper).
    assert.ok(stdout.includes("EXT:default:object:Object:DS"), stdout);
  });

  it("exposes both default and named exports when they coexist", async () => {
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("mixed-exports.ts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("default:object:Object:DS"), stdout);
    assert.ok(stdout.includes("helper:object:Object:HLP"), stdout);
  });

  it("exposes named-only exports", async () => {
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("named-only.ts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("AppDS:object:Object:APP"), stdout);
    assert.ok(stdout.includes("Other:object:Object:OTHER"), stdout);
  });

  it("handles circular imports without TDZ errors", async () => {
    const { stdout, stderr, exitCode } = await run([EXT_HARNESS, TARGET("circular-a.ts")]);
    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes("circular-a loaded"), stdout);
    assert.ok(stdout.includes("circular-b loaded"), stdout);
    assert.ok(!stderr.includes("before initialization"), stderr);
  });

  it("emits decorator metadata via the ModuleRunner's tsconfig-driven transform", async () => {
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("entity.ts")]);
    assert.equal(exitCode, 0);
    // Vite 8 auto-picks up the fixture's tsconfig (experimentalDecorators +
    // emitDecoratorMetadata), so Reflect.getMetadata yields real types.
    assert.ok(stdout.includes("ENTITY:id=Number,name=String"), stdout);
  });

  it("applies the same hook to .mts files", async () => {
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("decorated.mts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("MTS:n=Number"), stdout);
  });

  it("handles primitive default with coexisting named exports (fallback path)", async () => {
    // `export default 42` can't be the stub's module.exports (Node's CJS→ESM
    // would strip it) and we can't attach named siblings to a primitive, so
    // the stub falls back to exports.default. Default becomes double-wrapped
    // but the named export is reachable — which is the important property.
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("primitive-default.ts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("helper:object:Object:HLP"), stdout);
  });

  it("caches the stub: two native import()s of the same .ts yield identical namespaces", async () => {
    // Regression guard for the Map.delete() in the stub. If Node weren't
    // caching, the second import would re-fire our hook; if that happened
    // AND the delete happened before re-read, the second call would throw
    // "module not loaded via runner". Asserting namespace identity also
    // guards against a silent double-load (which would hand consumers two
    // different exports objects for the same URL — a subtle data-race-
    // style bug).
    const DOUBLE = `${FIXTURES}/ext-harness/double.js`;
    const { stdout, exitCode } = await run([DOUBLE, TARGET("default-export.ts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("DOUBLE:ns=true:default=true"), stdout);
  });

  it("does not double-expose a named-only class via recursive namespace walk", async () => {
    // Regression guard for a real TypeORM bug hit in user migrations:
    // TypeORM's DirectoryExportedClassesLoader recurses into the imported
    // namespace via Object.values and collects every function it finds.
    // Without an __esModule marker, Node's CJS→ESM interop echoes
    // module.exports back as `mod.default`, so `{default: {SomeMig}, SomeMig}`
    // makes the recursive walk find the class twice.
    const REC = `${FIXTURES}/ext-harness/recursive-classes.js`;
    const { stdout, exitCode } = await run([REC, TARGET("migration-shape.ts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("RECURSIVE:found=1:unique=1"), stdout);
  });

  it("de-duplicates when a named export is the same value as default", async () => {
    // Regression for a real TypeORM bug: `export default class Foo {}` + a
    // named `Foo` export produced two Object.keys entries pointing at the
    // same class, so TypeORM's migration loader saw each migration twice.
    // The stub now identity-skips named-sibling assignments that alias the
    // default — the key still appears (cjs-module-lexer sees it statically)
    // but its runtime value is undefined, so iterators filtering falsy
    // values pick up the class once.
    const UNIQ = `${FIXTURES}/ext-harness/unique-values.js`;
    const { stdout, exitCode } = await run([UNIQ, TARGET("default-aliased-as-named.ts")]);
    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("UNIQ:keys=2:distinct=1"), stdout);
  });

  it("propagates errors from the user .ts file with .code preserved", async () => {
    // The ModuleRunner evaluates throws-at-toplevel.ts, which throws an
    // Error with a custom .code. That error travels back over the
    // MessagePort (structured clone preserves .code), through Node's
    // dynamic import() rejection, and into ext-harness's catch.
    const { stdout, exitCode } = await run([EXT_HARNESS, TARGET("throws-at-toplevel.ts")]);
    assert.equal(exitCode, 2);
    assert.ok(stdout.includes("EXTERR:ERR_FIXTURE_TOP_LEVEL:"), stdout);
    assert.ok(stdout.includes("fixture error"), stdout);
  });
});
