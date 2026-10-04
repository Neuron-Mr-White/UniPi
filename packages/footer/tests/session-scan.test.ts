/**
 * @pi-unipi/footer — Incremental session scan tests
 *
 * Feeding a branch in two steps must yield the same tracker state and
 * snapshot as one full scan; a shrunken branch or an appearing compaction
 * entry must trigger a full rescan; the trailing in-flight message must be
 * re-fed until it completes.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionScanner } from "../src/session-scan.ts";
import { tpsTracker } from "../src/tps-tracker.ts";

function userMsg(text: string): Record<string, unknown> {
  return { type: "message", timestamp: new Date(2026, 0, 1, 10, 0, 0).toISOString(), message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantMsg(text: string, out: number, at: Date, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    timestamp: at.toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 100, output: out, cacheRead: 10, cacheWrite: 0, cost: { total: 0.01 } },
      ...overrides,
    },
  };
}

function branch(step: number): unknown[] {
  // A deterministic branch: user → assistant pairs, tool call+result on step 2.
  const at = (m: number) => new Date(2026, 0, 1, 10, 0, m);
  const entries: unknown[] = [];
  for (let i = 1; i <= step; i++) {
    entries.push(userMsg(`u${i}`));
    entries.push(assistantMsg(`a${i}`, 10 + i, at(i)));
  }
  return entries;
}

/** Reference full scan on a private tracker (mirrors the scan call sequence). */
function fullScanReference(step: number): { snapshot: SessionScanner["snapshot"]; turnCount: number; stepCount: number } {
  const scanner = new SessionScanner();
  scanner.scan(branch(step));
  return { snapshot: scanner.snapshot, turnCount: tpsTracker.getTurnCount(), stepCount: tpsTracker.getStepCount() };
}

describe("SessionScanner (incremental scan)", () => {
  beforeEach(() => {
    tpsTracker.reset();
  });

  it("two-step feeding equals one full scan (snapshot + tracker)", () => {
    // Reference: single full scan of the whole branch.
    tpsTracker.reset();
    const ref = fullScanReference(3);

    // Subject: feed entries 0..2 now, the rest on the next tick.
    tpsTracker.reset();
    const scanner = new SessionScanner();
    const whole = branch(3);
    scanner.scan(whole.slice(0, 3));
    scanner.scan(whole);

    assert.deepEqual(scanner.snapshot, ref.snapshot);
    assert.equal(tpsTracker.getTurnCount(), ref.turnCount);
    assert.equal(tpsTracker.getStepCount(), ref.stepCount);
  });

  it("repeated identical scans are idempotent", () => {
    const scanner = new SessionScanner();
    const whole = branch(2);
    scanner.scan(whole);
    const snap = { ...scanner.snapshot };
    const turns = tpsTracker.getTurnCount();
    scanner.scan(whole);
    scanner.scan(whole);
    assert.deepEqual(scanner.snapshot, snap);
    assert.equal(tpsTracker.getTurnCount(), turns);
  });

  it("shrunken branch triggers a full rescan", () => {
    const scanner = new SessionScanner();
    scanner.scan(branch(4));
    assert.equal(scanner.snapshot.userCount, 4);

    const shrunk = branch(2);
    assert.equal(scanner.needsFullRescan(shrunk), true);

    scanner.reset();
    tpsTracker.reset();
    scanner.scan(shrunk);
    assert.equal(scanner.snapshot.userCount, 2);
    assert.equal(scanner.snapshot.assistantCount, 2);
    // Tracker reflects the new branch, not a mix.
    assert.equal(tpsTracker.getTurnCount(), 2);
  });

  it("needsFullRescan is true for the first scan and new compaction tails", () => {
    const scanner = new SessionScanner();
    assert.equal(scanner.needsFullRescan([]), true);
    scanner.scan(branch(2));
    assert.equal(scanner.needsFullRescan(branch(2)), false);

    const withCompaction = [...branch(2), { type: "compaction", tokensBefore: 1000, summary: "x".repeat(1300), timestamp: new Date().toISOString() }];
    assert.equal(scanner.needsFullRescan(withCompaction), true);
  });

  it("compaction entries accumulate in the snapshot", () => {
    const scanner = new SessionScanner();
    const withCompaction = [...branch(2), { type: "compaction", tokensBefore: 39_000, summary: "x".repeat(52_000), timestamp: new Date().toISOString() }];
    tpsTracker.reset();
    scanner.scan(withCompaction);
    assert.equal(scanner.snapshot.compactionCount, 1);
    assert.equal(scanner.snapshot.compactionBefore, 39_000);
    assert.equal(scanner.snapshot.compactionAfter, 13_000);
    assert.ok(scanner.snapshot.compactionLastAt != null);
  });

  it("re-feeds the trailing in-flight message until it has a stopReason", () => {
    const at = new Date(2026, 0, 1, 10, 5, 0);
    const scanner = new SessionScanner();
    tpsTracker.reset();
    const inflight = assistantMsg("streaming", 5, at, { stopReason: undefined });
    const whole = [...branch(2), inflight];
    scanner.scan(whole);
    assert.equal(scanner.needsFullRescan(whole), false);
    assert.equal(scanner.snapshot.assistantCount, 3);
    const turnsAfterFirst = tpsTracker.getTurnCount();
    // Partial usage counted at first sighting (a1=11, a2=12, inflight=5).
    assert.equal(scanner.snapshot.output, 28);

    // Next tick: the tail entry completed in place with final usage.
    const completed = assistantMsg("streaming", 77, at, {});
    const updated = [...whole.slice(0, -1), completed];
    scanner.scan(updated);
    // The re-feed swapped the partial contribution for the final usage.
    assert.equal(scanner.snapshot.output, 100);
    assert.equal(scanner.snapshot.assistantCount, 3);
    assert.equal(turnsAfterFirst, tpsTracker.getTurnCount());
  });

  it("tool call → result pairing works across incremental scans", () => {
    const at = (m: number) => new Date(2026, 0, 1, 10, 0, m);
    const callEntry = {
      type: "message",
      timestamp: at(1).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-9", name: "bash" }],
        stopReason: "toolUse",
        usage: { input: 10, output: 2, cost: { total: 0 } },
      },
    };
    const resultEntry = {
      type: "message",
      timestamp: at(5).toISOString(), // 4 seconds later
      message: { role: "toolResult", toolCallId: "call-9", content: [{ type: "text", text: "ok" }] },
    };

    tpsTracker.reset();
    const scanner = new SessionScanner();
    scanner.scan([userMsg("u1"), callEntry]);
    scanner.scan([userMsg("u1"), callEntry, resultEntry]);
    assert.equal(tpsTracker.getToolMs(), 4_000);

    // Single-shot scan reaches the same number.
    tpsTracker.reset();
    new SessionScanner().scan([userMsg("u1"), callEntry, resultEntry]);
    assert.equal(tpsTracker.getToolMs(), 4_000);
  });
});
