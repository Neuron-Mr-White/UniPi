import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MIGRATION_STATE_VERSION,
  compareVersions,
  getMemorySourceFingerprint,
  isMigrated,
  isUpdateCheckDue,
  markMigrated,
  readMigrationState,
  readUpdateState,
  resolveMempalaceBridgePath,
  writeUpdateState,
  type MigrationResult,
} from "../mempalace.js";
import { parseMemoryFile, writeMemoryFile, type MemoryRecord } from "../storage.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "unipi-memory-test-"));
  cleanup.push(dir);
  return dir;
}

function successfulResult(discovered = 1): MigrationResult {
  return {
    discovered,
    imported: discovered,
    updated: discovered,
    skipped: 0,
    failed: 0,
    verified: discovered,
  };
}

describe("MemPalace bridge packaging", () => {
  it("resolves the source/standalone package bridge", () => {
    const resolved = resolveMempalaceBridgePath(import.meta.url);
    assert.ok(resolved?.endsWith("packages/memory/bridge/mempalace_bridge.py"));
  });

  it("resolves an umbrella bundle's sibling memory bridge", () => {
    const root = tempDir();
    const bundle = join(root, "packages", "unipi", "bundled.js");
    const bridge = join(root, "packages", "memory", "bridge", "mempalace_bridge.py");
    mkdirSync(join(root, "packages", "unipi"), { recursive: true });
    mkdirSync(join(root, "packages", "memory", "bridge"), { recursive: true });
    writeFileSync(bundle, "// fixture\n");
    writeFileSync(bridge, "# fixture\n");

    assert.equal(resolveMempalaceBridgePath(pathToFileURL(bundle).href), bridge);
  });
});

describe("durable markdown identity", () => {
  it("round-trips the authoritative record ID", () => {
    const root = tempDir();
    const file = join(root, "hello_.md");
    const record: MemoryRecord = {
      id: "hello_",
      title: "Hello!",
      content: "body",
      tags: ["test"],
      project: "project",
      type: "summary",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    };
    writeMemoryFile(file, record);
    assert.equal(parseMemoryFile(file)?.id, "hello_");
  });
});

describe("MemPalace migration state", () => {
  it("does not accept legacy timestamp markers", () => {
    const root = tempDir();
    const flag = join(root, ".mempalace-migrated");
    writeFileSync(flag, new Date().toISOString());
    assert.equal(readMigrationState(flag), null);
  });

  it("does not mark partial or failed migrations complete", () => {
    const root = tempDir();
    const flag = join(root, ".mempalace-migrated");
    assert.equal(markMigrated("abc", { ...successfulResult(2), verified: 1 }, flag), false);
    assert.equal(readMigrationState(flag), null);
    assert.equal(markMigrated("abc", { ...successfulResult(2), failed: 1 }, flag), false);
    assert.equal(readMigrationState(flag), null);
  });

  it("writes and reads a verified versioned migration state", () => {
    const root = tempDir();
    const flag = join(root, ".mempalace-migrated");
    assert.equal(markMigrated("abc", successfulResult(2), flag), true);
    const state = readMigrationState(flag);
    assert.equal(state?.version, MIGRATION_STATE_VERSION);
    assert.equal(state?.sourceFingerprint, "abc");
    assert.equal(state?.result.verified, 2);
  });

  it("changes source fingerprint when durable memory sources change", () => {
    const root = tempDir();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "one.md"), "first");
    const before = getMemorySourceFingerprint(root);
    writeFileSync(join(project, "one.md"), "second and longer");
    const after = getMemorySourceFingerprint(root);
    assert.notEqual(after, before);
  });

  it("only considers the current source fingerprint migrated", () => {
    const root = tempDir();
    const source = join(root, "source");
    const flag = join(root, ".mempalace-migrated");
    mkdirSync(source);
    writeFileSync(join(source, "one.md"), "first");
    const fingerprint = getMemorySourceFingerprint(source);
    assert.equal(markMigrated(fingerprint, successfulResult(), flag), true);

    assert.equal(isMigrated(fingerprint, flag), true);
    writeFileSync(join(source, "two.md"), "second");
    assert.notEqual(getMemorySourceFingerprint(source), fingerprint);
    assert.equal(isMigrated(getMemorySourceFingerprint(source), flag), false);
  });
});

describe("MemPalace auto-update", () => {
  it("compares dotted versions numerically, not lexically", () => {
    assert.equal(compareVersions("3.5.0", "3.5.0"), 0);
    assert.ok(compareVersions("3.10.0", "3.9.9") > 0);
    assert.ok(compareVersions("3.5", "3.5.1") < 0);
    assert.ok(compareVersions("4.0.0rc1", "4.0.0") === 0);
  });

  it("is due with no state, not due within the TTL, due again after it", () => {
    const flag = join(tempDir(), ".mempalace-update");
    assert.equal(isUpdateCheckDue(flag, 1_000, 10_000), true);
    writeUpdateState({ checkedAt: 1_000, latestVersion: "3.5.0" }, flag);
    assert.equal(isUpdateCheckDue(flag, 10_999, 10_000), false);
    assert.equal(isUpdateCheckDue(flag, 11_000, 10_000), true);
  });

  it("rejects a corrupt update state file", () => {
    const flag = join(tempDir(), ".mempalace-update");
    writeFileSync(flag, "not json");
    assert.equal(readUpdateState(flag), null);
  });

  it("is disabled when the setting is off", async () => {
    const { maybeAutoUpdateMempalace } = await import("../mempalace.js");
    const { updateEmbeddingConfig } = await import("../settings.js");
    updateEmbeddingConfig({ mempalaceAutoUpdate: false });
    try {
      const outcome = await maybeAutoUpdateMempalace({ force: true });
      assert.equal(outcome.checked, false);
      assert.equal(outcome.reason, "disabled");
    } finally {
      updateEmbeddingConfig({ mempalaceAutoUpdate: true });
    }
  });
});
