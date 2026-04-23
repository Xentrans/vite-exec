import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIgnored } from "../dist/watch.js";

const CWD = "/tmp/proj";

function matches(ignored: ReturnType<typeof buildIgnored>, path: string) {
  return ignored.some((m) => (m instanceof RegExp ? m.test(path) : m(path)));
}

describe("buildIgnored", () => {
  it("ignores node_modules, .git, dist by default", () => {
    const ignored = buildIgnored([], CWD);
    assert.ok(matches(ignored, `${CWD}/node_modules/foo/index.js`));
    assert.ok(matches(ignored, `${CWD}/.git/HEAD`));
    assert.ok(matches(ignored, `${CWD}/dist/index.js`));
    assert.ok(matches(ignored, `${CWD}/packages/a/node_modules/b/index.js`));
  });

  it("does not ignore ordinary source files", () => {
    const ignored = buildIgnored([], CWD);
    assert.ok(!matches(ignored, `${CWD}/src/index.ts`));
    assert.ok(!matches(ignored, `${CWD}/README.md`));
    // 'distribute.ts' must not match the 'dist' default — the regex
    // requires a path-segment boundary, not a substring.
    assert.ok(!matches(ignored, `${CWD}/src/distribute.ts`));
  });

  it("honors user glob patterns relative to cwd", () => {
    const ignored = buildIgnored(["**/*.test.ts"], CWD);
    assert.ok(matches(ignored, `${CWD}/src/foo.test.ts`));
    assert.ok(matches(ignored, `${CWD}/foo.test.ts`));
    assert.ok(!matches(ignored, `${CWD}/src/foo.ts`));
  });

  it("matches dotfile globs via { dot: true }", () => {
    const ignored = buildIgnored(["**/.env*"], CWD);
    assert.ok(matches(ignored, `${CWD}/.env`));
    assert.ok(matches(ignored, `${CWD}/packages/a/.env.local`));
  });
});
