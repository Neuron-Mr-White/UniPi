import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBase64, registerPath, resolveMedia, resetMediaForTests, bridgeDir } from "../src/media.js";

describe("media registry", () => {
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "unipi-bridge-media-"));
    prevDir = process.env.UNIPI_BRIDGE_DIR;
    process.env.UNIPI_BRIDGE_DIR = dir;
    resetMediaForTests();
  });
  afterEach(() => {
    if (prevDir === undefined) delete process.env.UNIPI_BRIDGE_DIR;
    else process.env.UNIPI_BRIDGE_DIR = prevDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers base64 and resolves it back by ref", () => {
    const ref = registerBase64("aGVsbG8=", "image/png");
    const entry = resolveMedia(ref);
    assert.deepEqual(entry, { kind: "base64", data: "aGVsbG8=", mime: "image/png" });
  });

  it("unknown refs resolve to undefined", () => {
    assert.equal(resolveMedia("no-such-ref"), undefined);
  });

  it("registering a path writes the host allow-list file and resolves to it", () => {
    const ref = registerPath("/tmp/shot.png", "image/png");
    assert.deepEqual(resolveMedia(ref), { kind: "path", path: "/tmp/shot.png", mime: "image/png" });
    assert.equal(bridgeDir(), dir);
    const file = join(dir, `${process.pid}.files.json`);
    assert.ok(existsSync(file));
    const list = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(list, ["/tmp/shot.png"]);
  });

  it("registering the same path twice doesn't duplicate the allow-list", () => {
    registerPath("/tmp/a.png");
    registerPath("/tmp/a.png");
    registerPath("/tmp/b.png");
    const file = join(dir, `${process.pid}.files.json`);
    const list = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(list.sort(), ["/tmp/a.png", "/tmp/b.png"]);
  });

  it("evicts the oldest ref once past the cap", () => {
    let firstRef: string | undefined;
    for (let i = 0; i < 501; i++) {
      const ref = registerBase64(`data-${i}`, "image/png");
      if (i === 0) firstRef = ref;
    }
    assert.equal(resolveMedia(firstRef!), undefined, "the oldest entry was evicted");
  });
});
