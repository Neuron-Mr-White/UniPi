/**
 * Unit tests for RegisterStore (stash-only; old files with numbered
 * registers must still load).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RegisterStore } from "../src/registers.ts";

describe("RegisterStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "input-shortcuts-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates file on first write", () => {
    const store = new RegisterStore(tmpDir);
    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    assert.equal(existsSync(filePath), false);

    store.setStash("hello");
    assert.equal(existsSync(filePath), true);
  });

  it("loads existing data from file", () => {
    const store1 = new RegisterStore(tmpDir);
    store1.setStash("persisted");

    const store2 = new RegisterStore(tmpDir);
    assert.equal(store2.getStash(), "persisted");
  });

  it("read/write stash roundtrip", () => {
    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "");

    store.setStash("my stash text");
    assert.equal(store.getStash(), "my stash text");

    store.setStash("");
    assert.equal(store.getStash(), "");
  });

  it("loads an old file that still has numbered registers (they are ignored)", () => {
    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    mkdirSync(join(tmpDir, ".unipi/config"), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ stash: "kept", registers: ["r0", "r1", "", "", "", "", "", "", "", ""] }),
      "utf-8",
    );

    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "kept");

    // Saving rewrites the file without the legacy keys.
    store.setStash("kept2");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    assert.equal(parsed.stash, "kept2");
    assert.equal("registers" in parsed, false);
  });

  it("handles corrupt file gracefully", () => {
    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    const dir = join(tmpDir, ".unipi/config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "not valid json!!!", "utf-8");

    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "");
  });

  it("handles partial data in file", () => {
    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    const dir = join(tmpDir, ".unipi/config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ stash: "ok" }), "utf-8");

    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "ok");
  });

  it("atomic write produces valid JSON", () => {
    const store = new RegisterStore(tmpDir);
    store.setStash("test");

    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as { stash: string };
    assert.equal(parsed.stash, "test");
  });
});
