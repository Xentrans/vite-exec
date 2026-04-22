import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const FIXTURES = resolve(import.meta.dirname, "fixtures");

function run(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("node", [CLI, ...args], (error, stdout, stderr) => {
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
    // -e ts must be recognized as flag + value (not two positionals);
    // the file path is the first non-flag arg after the value.
    const { stdout, exitCode } = await run([
      "-e",
      "ts",
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
    assert.ok(stderr.includes("No file specified"));
    assert.ok(stderr.includes("Usage:"));
  });

  it("prints error and exits 1 when file is not found", async () => {
    const { exitCode, stderr } = await run(["nonexistent.ts"]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("File not found"));
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
