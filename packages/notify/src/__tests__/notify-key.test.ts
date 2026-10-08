/**
 * UNI-161 §1: the pi-side notify key loader reads
 * `$UNIPI_HOST_DIR/notify-key` (same file `unipi-host`'s
 * `notify_key_or_create` generates/persists), falling back to
 * `~/.unipi/app-host/notify-key` when `$UNIPI_HOST_DIR` is unset.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { notifyKeyPath, loadNotifyKey } from "../../notify-key.ts";

describe("notifyKeyPath / loadNotifyKey", () => {
  let dir: string;
  let originalHostDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notify-key-"));
    originalHostDir = process.env.UNIPI_HOST_DIR;
    process.env.UNIPI_HOST_DIR = dir;
  });
  afterEach(() => {
    if (originalHostDir === undefined) delete process.env.UNIPI_HOST_DIR;
    else process.env.UNIPI_HOST_DIR = originalHostDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves to $UNIPI_HOST_DIR/notify-key", () => {
    assert.equal(notifyKeyPath(), join(dir, "notify-key"));
  });

  it("returns undefined when the key file doesn't exist yet (host hasn't generated one)", () => {
    assert.equal(loadNotifyKey(), undefined);
  });

  it("reads the 32-byte key the host persisted", () => {
    const key = randomBytes(32);
    writeFileSync(join(dir, "notify-key"), key);
    const loaded = loadNotifyKey();
    assert.ok(loaded);
    assert.ok(loaded!.equals(key));
  });

  it("returns undefined for a malformed (wrong-length) key file", () => {
    writeFileSync(join(dir, "notify-key"), randomBytes(16));
    assert.equal(loadNotifyKey(), undefined);
  });

  it("falls back to ~/.unipi/app-host/notify-key when UNIPI_HOST_DIR is unset", () => {
    delete process.env.UNIPI_HOST_DIR;
    const home = mkdtempSync(join(tmpdir(), "notify-key-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, ".unipi", "app-host"), { recursive: true });
      const key = randomBytes(32);
      writeFileSync(join(home, ".unipi", "app-host", "notify-key"), key);
      assert.equal(notifyKeyPath(), join(home, ".unipi", "app-host", "notify-key"));
      assert.ok(loadNotifyKey()!.equals(key));
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
