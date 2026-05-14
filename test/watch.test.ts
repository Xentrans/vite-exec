import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { buildIgnored } from "../dist/watch.js";

const CWD = "/tmp/proj";

function matches(ignored: ReturnType<typeof buildIgnored>, path: string, stats?: Stats) {
  return ignored.some((m) => (m instanceof RegExp ? m.test(path) : m(path, stats)));
}

function fakeStats(overrides: Partial<Record<keyof Stats, boolean>>): Stats {
  const flags = { isFIFO: false, isSocket: false, isCharacterDevice: false, isBlockDevice: false, ...overrides };
  return {
    isFIFO: () => flags.isFIFO,
    isSocket: () => flags.isSocket,
    isCharacterDevice: () => flags.isCharacterDevice,
    isBlockDevice: () => flags.isBlockDevice,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  } as unknown as Stats;
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

  it("ignores FIFOs, sockets, and device files when stats are available", () => {
    const ignored = buildIgnored([], CWD);
    assert.ok(matches(ignored, `${CWD}/.env`, fakeStats({ isFIFO: true })));
    assert.ok(matches(ignored, `${CWD}/app.sock`, fakeStats({ isSocket: true })));
    assert.ok(matches(ignored, `${CWD}/dev-char`, fakeStats({ isCharacterDevice: true })));
    assert.ok(matches(ignored, `${CWD}/dev-blk`, fakeStats({ isBlockDevice: true })));
  });

  it("does not ignore regular files when stats indicate a regular file", () => {
    const ignored = buildIgnored([], CWD);
    assert.ok(!matches(ignored, `${CWD}/src/index.ts`, fakeStats({})));
  });

  it("does not ignore on the stats-less first pass", () => {
    // chokidar calls the ignore fn twice — first path-only, then with stats.
    // The first call must not pre-emptively drop paths it can't classify.
    const ignored = buildIgnored([], CWD);
    assert.ok(!matches(ignored, `${CWD}/.env`));
  });
});
