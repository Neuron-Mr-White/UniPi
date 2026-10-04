/**
 * @pi-unipi/footer — Strip data tests
 *
 * Tokens/cost parts (sums skip error/aborted, subscription → `sub`, zero cost
 * hidden) and the strip.* visibility toggles.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildStripParts } from "../src/strip.ts";
import { SessionScanner } from "../src/session-scan.ts";
import { tpsTracker } from "../src/tps-tracker.ts";
import type { StripToggles } from "../src/types.ts";

const STRIP_ON: StripToggles = {
  turns: true, time: true, speed: true, tokens: true, cost: true, compactions: true, cache: true,
};

function assistant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stopReason: "stop",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
      ...overrides,
    },
  };
}

function scanBranch(branch: unknown[]): SessionScanner {
  const scanner = new SessionScanner();
  scanner.scan(branch);
  return scanner;
}

describe("tokens/cost parts", () => {
  beforeEach(() => {
    tpsTracker.reset();
  });

  it("sums input/output tokens and cost over the branch", () => {
    const scanner = scanBranch([assistant(), assistant()]);
    const parts = buildStripParts(STRIP_ON, scanner.snapshot, {});
    const tokens = parts.find(p => p.id === "tokens");
    assert.ok(tokens, "tokens part present");
    assert.ok(tokens.text.includes("200 in"), `in total: ${tokens.text}`);
    assert.ok(tokens.text.includes("100 out"), `out total: ${tokens.text}`);
    const cost = parts.find(p => p.id === "cost");
    assert.ok(cost, "cost part present");
    assert.ok(cost.text.includes("$1.00"), `cost: ${cost.text}`);
  });

  it("skips error/aborted messages", () => {
    const scanner = scanBranch([
      assistant(),
      assistant({ stopReason: "error", usage: { input: 9_000, output: 9_000, cost: { total: 9 } } }),
      assistant({ stopReason: "aborted", usage: { input: 9_000, output: 9_000, cost: { total: 9 } } }),
    ]);
    const parts = buildStripParts(STRIP_ON, scanner.snapshot, {});
    const tokens = parts.find(p => p.id === "tokens")!;
    assert.ok(tokens.text.includes("100 in"), `only kept messages counted: ${tokens.text}`);
    assert.ok(tokens.text.includes("50 out"), `only kept messages counted: ${tokens.text}`);
    assert.ok(parts.find(p => p.id === "cost")!.text.includes("$0.50"));
    assert.equal(scanner.snapshot.assistantCount, 1);
  });

  it("shows `sub` when the model runs on a subscription", () => {
    const scanner = scanBranch([assistant()]);
    const parts = buildStripParts(STRIP_ON, scanner.snapshot, {
      model: { id: "claude-x" },
      modelRegistry: { isUsingOAuth: () => true },
    });
    assert.equal(parts.find(p => p.id === "cost")!.text.includes("sub"), true);
  });

  it("hides cost when zero and not on subscription", () => {
    const scanner = scanBranch([
      assistant({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }),
    ]);
    const parts = buildStripParts(STRIP_ON, scanner.snapshot, {});
    assert.ok(!parts.some(p => p.id === "cost"), "zero-cost non-sub cost part hidden");
    assert.ok(parts.some(p => p.id === "tokens"));
  });

  it("shows cost when zero but on subscription", () => {
    const scanner = scanBranch([
      assistant({ usage: { input: 10, output: 5, cost: { total: 0 } } }),
    ]);
    const parts = buildStripParts(STRIP_ON, scanner.snapshot, {
      model: { id: "m" },
      modelRegistry: { isUsingOAuth: () => true },
    });
    assert.ok(parts.find(p => p.id === "cost")!.text.includes("sub"));
  });

  it("tokens show plain words without arrows in text icon style", async () => {
    const { setIconStyle } = await import("../src/rendering/icons.ts");
    const scanner = scanBranch([assistant()]);
    setIconStyle("text");
    const parts = buildStripParts(STRIP_ON, scanner.snapshot, {});
    setIconStyle(undefined);
    const tokens = parts.find(p => p.id === "tokens")!;
    assert.ok(!tokens.text.includes("↑"), `no up arrow in text mode: ${tokens.text}`);
    assert.ok(!tokens.text.includes("↓"), `no down arrow in text mode: ${tokens.text}`);
    assert.ok(tokens.text.includes("100 in"), `plain in label: ${tokens.text}`);
    assert.ok(tokens.text.includes("50 out"), `plain out label: ${tokens.text}`);
  });
});

describe("strip toggles", () => {
  beforeEach(() => {
    tpsTracker.reset();
  });

  function scannerWithData(): SessionScanner {
    const scanner = new SessionScanner();
    scanner.scan([
      assistant({ usage: { input: 100, output: 50, cacheRead: 300, cacheWrite: 0, cost: { total: 0.5 } } }),
      { type: "compaction", tokensBefore: 39_000, summary: "s".repeat(52_000), timestamp: new Date().toISOString() },
    ]);
    // Seed tracker stats so turns/time/speed parts appear.
    tpsTracker.syncBranchStats(2, 1);
    tpsTracker.syncWallMs(12_000);
    tpsTracker.syncToolMs(4_000);
    tpsTracker.onTurnStart(Date.now());
    tpsTracker.onMessageUpdate(0, {
      role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop",
      timestamp: Date.now() - 1_000, usage: { output: 50 },
    }, true);
    tpsTracker.seedTtftFallback(Date.now() - 4_000, Date.now() - 1_000, 0);
    return scanner;
  }

  const piCtx = {};

  it("every part visible with all toggles on", () => {
    const scanner = scannerWithData();
    const ids = buildStripParts(STRIP_ON, scanner.snapshot, piCtx).map(p => p.id);
    for (const id of ["tokens", "cost", "speed", "turns", "time", "cache", "compactions"] as const) {
      assert.ok(ids.includes(id), `${id} expected on`);
    }
  });

  for (const toggle of ["tokens", "cost", "speed", "turns", "time", "cache", "compactions"] as const) {
    it(`strip.${toggle}=false hides its part only`, () => {
      const scanner = scannerWithData();
      const parts = buildStripParts({ ...STRIP_ON, [toggle]: false }, scanner.snapshot, piCtx);
      assert.ok(!parts.some(p => p.id === toggle), `${toggle} must be hidden`);
    });
  }
});

// (subscription probe identity kept local to each test)
