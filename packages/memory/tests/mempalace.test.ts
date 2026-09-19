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
  bumpDeferredRetry,
  deferredRetryDue,
  isMigrated,
  isMigrationComplete,
  normalizeMigrationResult,
  isTransientBridgeError,
  isUpdateCheckDue,
  markMigrated,
  readMigrationState,
  readUpdateState,
  resolveMempalaceBridgePath,
  writeUpdateState,
  hashBytes,
  readLedger,
  writeLedger,
  scanMemorySources,
  ledgerDelta,
  applyMigrationToLedger,
  ledgerRecordStore,
  bootstrapLedgerFromLegacyMarker,
  LEDGER_VERSION,
  type Ledger,
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

  it("accepts a run whose only shortfall is transiently deferred records", () => {
    const flag = join(tempDir(), ".mempalace-migrated");
    const now = 1_000_000;
    const result: MigrationResult = {
      discovered: 3, imported: 1, updated: 1, skipped: 1, failed: 0,
      deferred: 1, verified: 2, deferredKeys: ["proj/a"],
    };
    assert.equal(isMigrationComplete(result), true);
    assert.equal(markMigrated("fp", result, flag, now), true);
    const state = readMigrationState(flag);
    assert.deepEqual(state?.deferredKeys, ["proj/a"]);
    assert.equal(state?.attempts, 1);
    assert.equal(state?.retryAfter, now + 15 * 60_000); // first backoff step
    // isMigrated is true (complete), but the deferred key is due only later.
    assert.equal(isMigrated("fp", flag), true);
    assert.equal(deferredRetryDue("fp", flag, now + 60_000), null); // inside backoff
    assert.deepEqual(deferredRetryDue("fp", flag, now + 16 * 60_000), ["proj/a"]);
  });

  it("still refuses a run with a genuine failure", () => {
    const flag = join(tempDir(), ".mempalace-migrated");
    const result: MigrationResult = {
      discovered: 2, imported: 0, updated: 0, skipped: 1, failed: 1, deferred: 0, verified: 1,
    };
    assert.equal(isMigrationComplete(result), false);
    assert.equal(markMigrated("fp", result, flag), false);
    assert.equal(readMigrationState(flag), null);
  });

  it("escalates the deferred backoff on repeated contention", () => {
    const flag = join(tempDir(), ".mempalace-migrated");
    const now = 5_000_000;
    const deferredResult: MigrationResult = {
      discovered: 1, imported: 0, updated: 0, skipped: 0, failed: 0,
      deferred: 1, verified: 0, deferredKeys: ["p/x"],
    };
    markMigrated("fp", deferredResult, flag, now);
    assert.equal(readMigrationState(flag)?.attempts, 1);
    // A second complete-with-deferral run bumps attempts → longer backoff.
    markMigrated("fp", deferredResult, flag, now);
    assert.equal(readMigrationState(flag)?.attempts, 2);
    assert.equal(readMigrationState(flag)?.retryAfter, now + 60 * 60_000);
    // bumpDeferredRetry pushes the window without clearing the keys.
    bumpDeferredRetry("fp", flag, now);
    const s = readMigrationState(flag);
    assert.equal(s?.attempts, 3);
    assert.deepEqual(s?.deferredKeys, ["p/x"]);
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

describe("migration result normalization", () => {
  it("maps the bridge snake_case deferred_keys into deferredKeys", () => {
    const raw = {
      discovered: 3979, imported: 0, updated: 0, skipped: 3659, failed: 0,
      deferred: 320, verified: 3659, errors: [], deferred_keys: ["a/b", "c/d"],
    };
    const r = normalizeMigrationResult(raw);
    assert.equal(r?.deferred, 320);
    assert.deepEqual(r?.deferredKeys, ["a/b", "c/d"]);
    assert.equal(isMigrationComplete(r!), true);
  });

  it("returns null for a missing or malformed payload", () => {
    assert.equal(normalizeMigrationResult(null), null);
    assert.equal(normalizeMigrationResult({ nope: 1 }), null);
  });
});

describe("transient bridge error classification", () => {
  it("treats palace-lock contention as transient", () => {
    assert.equal(
      isTransientBridgeError("MineAlreadyRunning: palace /p is held by PID 123 (daemon serve); wait"),
      true,
    );
    assert.equal(isTransientBridgeError("palace /p is held by PID 9"), true);
  });

  it("treats real backend errors and empty values as non-transient", () => {
    assert.equal(isTransientBridgeError("ValueError: bad record"), false);
    assert.equal(isTransientBridgeError("mempalace init failed: ImportError"), false);
    assert.equal(isTransientBridgeError(undefined), false);
    assert.equal(isTransientBridgeError(null), false);
    assert.equal(isTransientBridgeError(""), false);
  });
});

describe("record-level sync ledger (L2)", () => {
  function seedMd(root: string, project: string, id: string, body: string): string {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.md`);
    writeFileSync(file, `---\nid: ${id}\ntitle: ${id}\nproject: ${project}\ntype: summary\n---\n\n${body}\n`);
    return file;
  }

  it("scans markdown (not memory.db) and keys by project/id", () => {
    const root = tempDir();
    seedMd(root, "proj", "alpha", "one");
    writeFileSync(join(root, "proj", "memory.db"), "binary-ish");
    const scanned = scanMemorySources(root);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0]?.key, "proj/alpha");
    assert.ok(scanned[0]?.hash.length === 64);
  });

  it("delta is empty when the ledger matches on-disk hashes", () => {
    const root = tempDir();
    seedMd(root, "proj", "alpha", "one");
    const scanned = scanMemorySources(root);
    const ledger = readLedger(join(tempDir(), ".ledger.json"));
    ledger.entries[scanned[0]!.key] = { hash: scanned[0]!.hash };
    assert.deepEqual(ledgerDelta(scanned, ledger).keys, []);
  });

  it("delta flags changed files and honours deferred backoff", () => {
    const root = tempDir();
    seedMd(root, "proj", "alpha", "one");
    seedMd(root, "proj", "beta", "two");
    const scanned = scanMemorySources(root);
    const ledger = readLedger(join(tempDir(), ".ledger.json"));
    // alpha in sync, beta unknown → beta is due; first run flagged when empty.
    const first = ledgerDelta(scanned, ledger);
    assert.equal(first.firstRun, true);
    for (const r of scanned) ledger.entries[r.key] = { hash: r.hash };
    // Now mutate alpha on disk → alpha due.
    seedMd(root, "proj", "alpha", "one CHANGED");
    const rescanned = scanMemorySources(root);
    assert.deepEqual(ledgerDelta(rescanned, ledger).keys, ["proj/alpha"]);
    // Deferred key inside backoff is not due; after backoff it is.
    ledger.deferredKeys = ["proj/gamma"];
    ledger.retryAfter = 10_000;
    for (const r of rescanned) ledger.entries[r.key] = { hash: r.hash };
    assert.deepEqual(ledgerDelta(rescanned, ledger, 5_000).keys, []);
    assert.deepEqual(ledgerDelta(rescanned, ledger, 20_000).keys, ["proj/gamma"]);
  });

  it("applyMigrationToLedger advances verified keys and reschedules deferred/failed", () => {
    const ledger = readLedger(join(tempDir(), ".ledger.json"));
    const scannedByKey = new Map([["p/a", "hashA"], ["p/b", "hashB"]]);
    const result: MigrationResult = {
      discovered: 3, imported: 1, updated: 1, skipped: 0, failed: 1, deferred: 1, verified: 1,
      verifiedKeys: ["p/a"], deferredKeys: ["p/b"], errors: ["p/c: ValueError: bad"],
    };
    const now = 1_000_000;
    const next = applyMigrationToLedger(ledger, result, scannedByKey, now);
    assert.deepEqual(next.entries["p/a"], { hash: "hashA" });
    assert.equal(next.entries["p/b"], undefined); // deferred → not recorded
    assert.deepEqual(next.deferredKeys, ["p/b"]);
    assert.deepEqual(next.failedKeys, ["p/c"]);
    assert.equal(next.attempts, 1);
    assert.equal(next.retryAfter, now + 15 * 60_000);
  });

  it("ledgerRecordStore records a key and clears its pending retry state", () => {
    const flag = join(tempDir(), ".ledger.json");
    const seeded: Ledger = {
      version: LEDGER_VERSION, entries: {}, deferredKeys: ["p/a"], failedKeys: ["p/a"],
      attempts: 2, retryAfter: 999, updatedAt: new Date(0).toISOString(),
    };
    writeLedger(seeded, flag);
    ledgerRecordStore("p/a", "some bytes", flag);
    const after = readLedger(flag);
    assert.equal(after.entries["p/a"]?.hash, hashBytes("some bytes"));
    assert.deepEqual(after.deferredKeys, []);
    assert.deepEqual(after.failedKeys, []);
  });

  it("bootstraps the ledger from a completed legacy marker, carrying deferred keys", () => {
    const root = tempDir();
    seedMd(root, "proj", "alpha", "one");
    seedMd(root, "proj", "beta", "two");
    const ledgerPath = join(root, ".mempalace-ledger.json");
    const markerPath = join(root, ".mempalace-migrated");
    // Complete marker with beta deferred.
    markMigrated("fp", {
      discovered: 2, imported: 0, updated: 0, skipped: 1, failed: 0, deferred: 1, verified: 1,
      deferredKeys: ["proj/beta"],
    }, markerPath);
    const ledger = bootstrapLedgerFromLegacyMarker(root, ledgerPath, markerPath);
    assert.ok(ledger);
    assert.ok(ledger!.entries["proj/alpha"]); // verified → seeded
    assert.equal(ledger!.entries["proj/beta"], undefined); // deferred → not seeded
    assert.deepEqual(ledger!.deferredKeys, ["proj/beta"]);
    // Idempotent: a second call returns null (ledger already exists).
    assert.equal(bootstrapLedgerFromLegacyMarker(root, ledgerPath, markerPath), null);
  });
});

describe("daemon awareness (L3)", () => {
  it("returns not-reachable when no daemon endpoint exists", async () => {
    const { probeDaemon } = await import("../mempalace.js");
    const prev = process.env.MEMPALACE_DAEMON_STATE_ROOT;
    const root = tempDir();
    process.env.MEMPALACE_DAEMON_STATE_ROOT = root;
    try {
      const palace = tempDir();
      const status = await probeDaemon(palace, 200);
      assert.deepEqual(status, { reachable: false, busy: false });
    } finally {
      if (prev === undefined) delete process.env.MEMPALACE_DAEMON_STATE_ROOT;
      else process.env.MEMPALACE_DAEMON_STATE_ROOT = prev;
    }
  });

  it("detects a reachable daemon and reports busy from active_job_id", async () => {
    const http = await import("node:http");
    const { createHash } = await import("node:crypto");
    const { realpathSync } = await import("node:fs");
    const { probeDaemon } = await import("../mempalace.js");

    // Start a stub daemon that authorizes on the token and reports busy.
    let activeJob: string | null = "job-1";
    let sawAuth = "";
    const server = http.createServer((req, res) => {
      sawAuth = req.headers["authorization"] ?? "";
      if (sawAuth !== "Bearer secret-token") { res.statusCode = 401; res.end("{}"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, active_job_id: activeJob }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as import("node:net").AddressInfo).port;

    const prev = process.env.MEMPALACE_DAEMON_STATE_ROOT;
    const root = tempDir();
    process.env.MEMPALACE_DAEMON_STATE_ROOT = root;
    try {
      const palace = tempDir();
      const key = createHash("sha256").update(realpathSync(palace)).digest("hex").slice(0, 24);
      const dir = join(root, key);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "endpoint.json"), JSON.stringify({ host: "127.0.0.1", port }));
      writeFileSync(join(dir, "token"), "secret-token\n");

      const busy = await probeDaemon(palace, 1000);
      assert.deepEqual(busy, { reachable: true, busy: true });
      assert.equal(sawAuth, "Bearer secret-token");

      activeJob = null; // idle
      const idle = await probeDaemon(palace, 1000);
      assert.deepEqual(idle, { reachable: true, busy: false });

      // Wrong token on disk → treated as unreachable (401).
      writeFileSync(join(dir, "token"), "wrong\n");
      const bad = await probeDaemon(palace, 1000);
      assert.deepEqual(bad, { reachable: false, busy: false });
    } finally {
      if (prev === undefined) delete process.env.MEMPALACE_DAEMON_STATE_ROOT;
      else process.env.MEMPALACE_DAEMON_STATE_ROOT = prev;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
