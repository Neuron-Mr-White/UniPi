/**
 * Compaction savings: tokens not re-sent × the context rate actually paid.
 * (Lives next to the viz tests so the core test glob picks it up.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactionSavings, SavingsAccumulator } from "../../compaction-savings.js";

const reply = (input: number, cacheRead: number, costIn: number, costRead: number) => ({
  type: "message",
  message: { role: "assistant", usage: { input, cacheRead, cacheWrite: 0, cost: { input: costIn, cacheRead: costRead, cacheWrite: 0 } } },
});

describe("compaction savings", () => {
  it("multiplies the saving by replies after it, priced at the paid context rate", () => {
    const { items, totals } = compactionSavings([
      reply(100_000, 0, 1, 0), // before any compaction — ignored
      { type: "compaction", timestamp: "2026-10-01T00:00:00Z", tokensBefore: 100_000 },
      reply(10_000, 10_000, 0.2, 0.05), // first reply: real context = 20k → after
      reply(5_000, 15_000, 0.1, 0.075),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.after, 20_000);
    assert.equal(items[0]!.replies, 2);
    assert.equal(totals.saved, 80_000);
    assert.equal(totals.avoided, 160_000);
    // paid 0.425 for 40k context tokens → $0.010625/1k → 160k × = $1.7
    assert.ok(Math.abs(totals.dollars - 1.7) < 1e-9, String(totals.dollars));
    assert.equal(totals.sent, 40_000);
  });

  it("prefers the compactor's own tokensAfter", () => {
    const { items } = compactionSavings([
      { type: "compaction", timestamp: "2026-10-01T00:00:00Z", tokensBefore: 50_000, details: { tokensAfter: 8_000 } },
      reply(30_000, 0, 0.3, 0),
    ]);
    assert.equal(items[0]!.after, 8_000);
  });

  it("counts a compaction copied into a forked file once", () => {
    const acc = new SavingsAccumulator();
    const c = { type: "compaction", timestamp: "2026-10-01T00:00:00Z", tokensBefore: 50_000 };
    acc.feed(c);
    acc.feed(reply(10_000, 0, 0.1, 0));
    acc.feed(c);
    acc.feed(reply(10_000, 0, 0.1, 0));
    assert.equal(acc.items.length, 1);
    assert.equal(acc.items[0]!.replies, 1);
  });

  it("free models save tokens but no money", () => {
    const { totals } = compactionSavings([
      { type: "compaction", timestamp: "2026-10-01T00:00:00Z", tokensBefore: 60_000 },
      reply(10_000, 0, 0, 0),
    ]);
    assert.equal(totals.avoided, 50_000);
    assert.equal(totals.dollars, 0);
  });
});
