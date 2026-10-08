import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInsideCwd } from "../src/bridge.js";
import { parseIn } from "../src/wire.js";

describe("isInsideCwd", () => {
  it("accepts the cwd itself and files/dirs under it", () => {
    assert.equal(isInsideCwd("/home/u/proj", "/home/u/proj"), true);
    assert.equal(isInsideCwd("/home/u/proj/src/a.ts", "/home/u/proj"), true);
    assert.equal(isInsideCwd("src/a.ts", "/home/u/proj"), true);
  });

  it("rejects paths outside the cwd, including sibling dirs that share a prefix", () => {
    assert.equal(isInsideCwd("/home/u/other", "/home/u/proj"), false);
    assert.equal(isInsideCwd("/home/u/proj-evil/x", "/home/u/proj"), false);
    assert.equal(isInsideCwd("/etc/passwd", "/home/u/proj"), false);
  });

  it("rejects .. climbing even when the spelled-out path starts inside the cwd", () => {
    assert.equal(isInsideCwd("/home/u/proj/../other", "/home/u/proj"), false);
    assert.equal(isInsideCwd("../../etc/passwd", "/home/u/proj"), false);
    assert.equal(isInsideCwd("subdir/../..", "/home/u/proj"), false);
  });
});

describe("parseIn file_share", () => {
  it("accepts a path and keeps ref", () => {
    assert.deepEqual(parseIn('{"t":"file_share","path":"/home/u/proj/a.png","ref":"r1"}'), { t: "file_share", path: "/home/u/proj/a.png", ref: "r1" });
  });
  it("rejects a missing/empty path", () => {
    assert.ok("bad" in (parseIn('{"t":"file_share"}') as object));
    assert.ok("bad" in (parseIn('{"t":"file_share","path":""}') as object));
  });
  it("clips an absurdly long path", () => {
    const long = "/a".repeat(3000);
    const parsed = parseIn(JSON.stringify({ t: "file_share", path: long })) as { path: string };
    assert.equal(parsed.path.length, 4096);
  });
});
