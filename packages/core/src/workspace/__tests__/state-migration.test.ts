import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateState, CURRENT_STATE_VERSION } from "../state-migration.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "unipi-mig-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seed(rel: string, file = "x"): void {
  const dir = join(home, ".unipi", rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), "data");
}

describe("state migration", () => {
  it("relocates global dirs and ARCHIVES v2 leftovers, once", () => {
    seed("db/compactor", "session.db");
    seed("images", "a.png");
    seed("analytics", "events.db");
    seed("cache/updater", "check.json");
    seed("state/fusion/sidekick", "old.jsonl");
    seed("trajectory", "dump.jsonl");

    const res = migrateState(home);
    assert.equal(res.ran, true);

    const g = (p: string) => join(home, ".unipi", "global", p);
    assert.ok(existsSync(join(g("compactor"), "session.db")));
    assert.ok(existsSync(join(g("image"), "a.png")));
    assert.ok(existsSync(join(g("utility"), "analytics", "events.db")));
    assert.ok(existsSync(join(g("updater"), "check.json")));

    // v2 leftovers archived — never deleted, land under .unipi/v2-archive/.
    assert.equal(existsSync(join(home, ".unipi", "state", "fusion")), false);
    assert.equal(existsSync(join(home, ".unipi", "trajectory")), false);
    const archive = join(home, ".unipi", "v2-archive");
    const dirs = readdirSync(archive);
    const fusion = dirs.find((d) => d.startsWith("fusion-"));
    const traj = dirs.find((d) => d.startsWith("trajectory-"));
    assert.ok(fusion && traj, `archive dirs: ${dirs}`);
    assert.ok(existsSync(join(archive, fusion, "sidekick", "old.jsonl")), "fusion data preserved");
    assert.ok(existsSync(join(archive, traj, "dump.jsonl")), "trajectory data preserved");
    assert.ok(res.log.some((e) => e.action === "archived"));

    // Version stamped.
    const marker = JSON.parse(readFileSync(join(home, ".unipi", "state-version.json"), "utf8"));
    assert.equal(marker.migrated_version, CURRENT_STATE_VERSION);

    // Second run is a no-op.
    const again = migrateState(home);
    assert.equal(again.ran, false);
  });

  it("merges into an existing destination without clobbering", () => {
    seed("db/compactor", "a.db");
    // Pre-existing dest entry with the same name must be preserved.
    const dest = join(home, ".unipi", "global", "compactor");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "a.db"), "KEEP");

    migrateState(home);
    assert.equal(readFileSync(join(dest, "a.db"), "utf8"), "KEEP", "existing dest kept");
  });

  it("is a no-op when nothing exists", () => {
    const res = migrateState(home);
    assert.equal(res.ran, true);
    assert.ok(res.log.every((e) => e.action === "skipped:missing"));
  });
});
