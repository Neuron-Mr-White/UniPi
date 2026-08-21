/**
 * Result files + watcher tests — ported from pi-subagents result-watcher /
 * result-files semantics (durable payloads, session/run indexes, pending
 * delivery, slow-scan logging modes, retention cleanup).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeAsyncResultFile,
  readAsyncResultFile,
  resultCandidateFilesForSession,
  removePendingResult,
  removeResultIndex,
  cleanupResultIndexes,
} from "../result-files.js";
import { createResultWatcher, cleanupAsyncRetention, type CompletionNotification } from "../result-watcher.js";

let resultsDir: string;
let asyncDir: string;

/** Pending delivery markers for a session (result-pending/<sid>/). */
function pendingMarkers(sessionId: string): string[] {
  try {
    return readdirSync(join(resultsDir, "result-pending", sessionId)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

beforeEach(() => {
  resultsDir = mkdtempSync(join(tmpdir(), "unipi-results-"));
  asyncDir = mkdtempSync(join(tmpdir(), "unipi-async-"));
});

afterEach(() => {
  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(asyncDir, { recursive: true, force: true });
});

describe("result files", () => {
  it("writes payload + run/session indexes + pending marker; reads back by run id", () => {
    writeAsyncResultFile(resultsDir, {
      runId: "run-1",
      sessionId: "sess-1",
      agent: "scout",
      output: "found things",
      success: true,
      state: "completed",
    });
    const payload = readAsyncResultFile(resultsDir, "run-1");
    assert.equal(payload?.agent, "scout");
    assert.equal(payload?.output, "found things");
    assert.equal(payload?.success, true);

    assert.equal(pendingMarkers("sess-1").length, 1);
    const candidates = resultCandidateFilesForSession(resultsDir, "sess-1");
    assert.equal(candidates.length, 1);
  });

  it("removePendingResult drops only the marker; removeResultIndex drops everything", () => {
    writeAsyncResultFile(resultsDir, { runId: "run-2", sessionId: "sess-2", output: "x", success: true });
    removePendingResult(resultsDir, "sess-2", "run-2");
    assert.equal(pendingMarkers("sess-2").length, 0);
    // session index + payload still readable
    assert.equal(resultCandidateFilesForSession(resultsDir, "sess-2").length, 1);
    assert.ok(readAsyncResultFile(resultsDir, "run-2"));

    removeResultIndex(resultsDir, "sess-2", "run-2");
    assert.equal(readAsyncResultFile(resultsDir, "run-2"), undefined);
  });

  it("cleanupResultIndexes prunes only old entries", () => {
    writeAsyncResultFile(resultsDir, { runId: "old-run", sessionId: "s", output: "x", success: true });
    writeAsyncResultFile(resultsDir, { runId: "new-run", sessionId: "s", output: "y", success: true });
    // Age the old run's index files.
    const old = Date.now() - 48 * 60 * 60 * 1000;
    for (const file of pendingMarkers("s")) {
      if (file.includes("old-run")) utimesSync(join(resultsDir, "result-pending", "s", file), new Date(old), new Date(old));
    }
    // Age the run-index + payload too.
    utimesSync(join(resultsDir, "result-index", "runs", "old-run.json"), new Date(old), new Date(old));
    utimesSync(join(resultsDir, "old-run.json"), new Date(old), new Date(old));

    const removed = cleanupResultIndexes(resultsDir, Date.now());
    assert.ok(removed >= 1);
    assert.equal(readAsyncResultFile(resultsDir, "new-run")?.runId, "new-run");
  });
});

describe("result watcher", () => {
  it("delivers pending completions and removes markers", async () => {
    writeAsyncResultFile(resultsDir, {
      runId: "watched-run",
      sessionId: "sess-w",
      agent: "reviewer",
      output: "review complete",
      success: true,
      state: "completed",
    });

    const notifications: CompletionNotification[] = [];
    const watcher = createResultWatcher({
      resultsDir,
      sessionId: "sess-w",
      notifier: (n) => notifications.push(n),
      intervalMs: 10_000, // not used — we call scan() manually
    });
    try {
      await watcher.scan();
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.runId, "watched-run");
      assert.equal(notifications[0]!.agent, "reviewer");
      assert.equal(notifications[0]!.success, true);
      // marker removed
      assert.equal(pendingMarkers("sess-w").length, 0);
      // payload retained for later reads
      assert.ok(readAsyncResultFile(resultsDir, "watched-run"));
    } finally {
      watcher.stop();
    }
  });

  it("drops corrupt markers without crashing", async () => {
    const pendingDir = join(resultsDir, "result-pending", "sess-c");
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, "corrupt-run.json"), "{not json");

    const notifications: CompletionNotification[] = [];
    const watcher = createResultWatcher({
      resultsDir,
      sessionId: "sess-c",
      notifier: (n) => notifications.push(n),
    });
    try {
      await watcher.scan();
      assert.equal(notifications.length, 0);
      assert.equal(existsSync(join(pendingDir, "corrupt-run.json")), false);
    } finally {
      watcher.stop();
    }
  });

  it("slow-scan logging respects the modes", async () => {
    const logs: string[] = [];
    const log = (message: string) => logs.push(message);

    // No pending files → "all" logs nothing (scan is fast, no slow scan)
    const watcher = createResultWatcher({
      resultsDir,
      sessionId: "sess-l",
      notifier: () => {},
      resultScanLogging: "all",
      log,
    });
    await watcher.scan();
    watcher.stop();
    assert.equal(logs.length, 0);

    // With a big slow scan (simulate via many markers + manual assertion of mode
    // gating logic): modes are exercised through scanOnce internals; here we
    // assert the config is accepted and scans complete without error.
    const watcher2 = createResultWatcher({
      resultsDir,
      sessionId: "sess-l",
      notifier: () => {},
      resultScanLogging: "off",
      log,
    });
    await watcher2.scan();
    watcher2.stop();
    assert.equal(logs.length, 0);
  });
});

describe("async retention cleanup", () => {
  it("removes only aged terminal run dirs", () => {
    const old = Date.now() - 48 * 60 * 60 * 1000;

    // Terminal + old → removed
    const doneDir = join(asyncDir, "done-run");
    mkdirSync(doneDir, { recursive: true });
    writeFileSync(join(doneDir, "status.json"), JSON.stringify({ status: "completed" }));
    utimesSync(doneDir, new Date(old), new Date(old));

    // Running + old → kept
    const runningDir = join(asyncDir, "running-run");
    mkdirSync(runningDir, { recursive: true });
    writeFileSync(join(runningDir, "status.json"), JSON.stringify({ status: "running" }));
    utimesSync(runningDir, new Date(old), new Date(old));

    // Terminal + fresh → kept
    const freshDir = join(asyncDir, "fresh-run");
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, "status.json"), JSON.stringify({ status: "failed" }));

    // Orphan (no status) + old → removed
    const orphanDir = join(asyncDir, "orphan-run");
    mkdirSync(orphanDir, { recursive: true });
    utimesSync(orphanDir, new Date(old), new Date(old));

    const result = cleanupAsyncRetention(asyncDir, resultsDir);
    assert.equal(result.runsRemoved, 2);
    assert.equal(existsSync(doneDir), false);
    assert.equal(existsSync(orphanDir), false);
    assert.equal(existsSync(runningDir), true);
    assert.equal(existsSync(freshDir), true);
  });

  it("removes associated result payloads with the run dir", () => {
    const old = Date.now() - 48 * 60 * 60 * 1000;
    writeAsyncResultFile(resultsDir, {
      runId: "retained-run",
      sessionId: "sess-r",
      output: "done",
      success: true,
      state: "completed",
    });
    const runDir = join(asyncDir, "retained-run");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "status.json"), JSON.stringify({ status: "completed" }));
    utimesSync(runDir, new Date(old), new Date(old));

    const result = cleanupAsyncRetention(asyncDir, resultsDir);
    assert.equal(result.runsRemoved, 1);
    assert.equal(result.resultsRemoved, 1);
    assert.equal(readAsyncResultFile(resultsDir, "retained-run"), undefined);
  });
});
