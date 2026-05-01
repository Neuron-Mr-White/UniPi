/**
 * Unit tests for RegisterStore.
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
    store1.setRegister(3, "reg3");

    const store2 = new RegisterStore(tmpDir);
    assert.equal(store2.getStash(), "persisted");
    assert.equal(store2.getRegister(3), "reg3");
  });

  it("read/write stash roundtrip", () => {
    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "");

    store.setStash("my stash text");
    assert.equal(store.getStash(), "my stash text");

    store.setStash("");
    assert.equal(store.getStash(), "");
  });

  it("read/write registers roundtrip", () => {
    const store = new RegisterStore(tmpDir);

    for (let i = 0; i < 10; i++) {
      assert.equal(store.getRegister(i), "");
    }

    store.setRegister(0, "zero");
    store.setRegister(9, "nine");
    assert.equal(store.getRegister(0), "zero");
    assert.equal(store.getRegister(9), "nine");
    assert.equal(store.getRegister(5), "");
  });

  it("ignores out-of-range register indices", () => {
    const store = new RegisterStore(tmpDir);
    assert.equal(store.getRegister(-1), "");
    assert.equal(store.getRegister(10), "");

    // Should not throw
    store.setRegister(-1, "bad");
    store.setRegister(10, "bad");
  });

  it("handles corrupt file gracefully", () => {
    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    const dir = join(tmpDir, ".unipi/config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "not valid json!!!", "utf-8");

    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "");
    assert.equal(store.getRegister(0), "");
  });

  it("handles partial data in file", () => {
    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    const dir = join(tmpDir, ".unipi/config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ stash: "ok" }), "utf-8");

    const store = new RegisterStore(tmpDir);
    assert.equal(store.getStash(), "ok");
    assert.equal(store.getRegister(0), "");
  });

  it("atomic write produces valid JSON", () => {
    const store = new RegisterStore(tmpDir);
    store.setStash("test");
    store.setRegister(1, "one");

    const filePath = join(tmpDir, ".unipi/config/input-shortcuts.json");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.stash, "test");
    assert.equal(parsed.registers[1], "one");
  });
});
