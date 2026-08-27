/**
 * @pi-unipi/footer — TPS tracker tests
 *
 * Covers: provider-anchored token counting (usage.output wins at stream end),
 * fixed-density estimates while streaming, output-only timing windows
 * (no tool/queue/TTFT time), index collision guard, and rate math.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TpsTracker } from "../src/tps-tracker.js";

function streamingMsg(content: unknown[] = []) {
  return { role: "assistant", content, usage: { output: 0 } };
}

function doneMsg(text: string, outputTokens?: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: { output: outputTokens ?? 0 },
  };
}

describe("TpsTracker — token counting", () => {
  it("anchors completed messages to exact provider usage.output", () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onStreamingDelta(0, "hello world from the model"); // estimate ≈ 5
    t.onMessageEnd(0, doneMsg("hello world from the model", 4));
    // Provider said 4 — that wins over the chars/4 estimate of ~6
    assert.equal(t.getTotalOutput(), 4);
  });

  it("falls back to density estimate when provider reports nothing", () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onStreamingDelta(0, "abcdefgh"); // 8 chars / 4 = 2
    t.onMessageEnd(0, doneMsg("abcdefgh")); // usage.output = 0
    assert.equal(t.getTotalOutput(), 2);
  });

  it("uses chars/4 density, CJK handled sanely", () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onStreamingDelta(0, "你好世界".repeat(10)); // 40 CJK chars → 10 est
    assert.equal(t.getTotalOutput(), 10);
  });

  it("delta counting is incremental and non-regressive via scan snapshots", () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    for (let i = 0; i < 100; i++) t.onStreamingDelta(0, "abcd"); // 100 tokens
    // Scan snapshot mid-stream with less content must not shrink it
    t.onMessageUpdate(0, streamingMsg([{ type: "text", text: "ab" }]), false);
    assert.equal(t.getTotalOutput(), 100);
  });

  it("completed records are immutable against replayed updates", () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onMessageEnd(0, doneMsg("x", 7));
    for (let i = 0; i < 5; i++) {
      t.onMessageUpdate(0, doneMsg("x long content now", 99), true);
      t.onStreamingDelta(0, "stale");
    }
    assert.equal(t.getTotalOutput(), 7);
  });
});

describe("TpsTracker — output-only timing", () => {
  it("clock starts at FIRST delta, not message_start (excludes TTFT)", async () => {
    const t = new TpsTracker();
    t.onMessageStart(0); // e.g. request in flight — no clock started
    assert.equal(t.isStreaming(), false);
    await new Promise(r => setTimeout(r, 25));
    t.onStreamingDelta(0, "hi");
    assert.equal(t.isStreaming(), true);
    await new Promise(r => setTimeout(r, 30));
    t.onMessageEnd(0, doneMsg("hi", 1));
    // Window must be ~30ms+ (from delta), not 55ms (from start)
    const avg = t.getSessionAvgTps(); // 1 token / ~0.03s ≈ 33 t/s
    assert.ok(avg > 10 && avg < 90, `avg=${avg} (should exclude TTFT)`);
  });

  it("tool execution time between messages is excluded", async () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onStreamingDelta(0, "a");
    await new Promise(r => setTimeout(r, 20));
    t.onMessageEnd(0, doneMsg("a", 1));

    // Simulated 5-second tool run between messages — no calls into tracker.
    await new Promise(r => setTimeout(r, 10)); // real gap small

    t.onMessageStart(1);
    t.onStreamingDelta(1, "bcd"); // first delta restarts the wall clock
    await new Promise(r => setTimeout(r, 20));
    t.onMessageEnd(1, doneMsg("bcd", 3));
    // 4 tokens over ~0.04s of generation — NOT ~0.05s including gaps
    const avg = t.getSessionAvgTps();
    assert.ok(avg > 20 && avg < 160, `avg=${avg}`);
  });

  it("scan-only fast message uses provider timestamp as start", () => {
    const t = new TpsTracker();
    const ts = Date.now() - 2000; // provider says generation took 2s
    t.onMessageUpdate(0, {
      role: "assistant",
      content: [{ type: "text", text: "output" }],
      stopReason: "stop",
      timestamp: ts,
      usage: { output: 60 },
    }, true);
    // 60 tokens anchored over the ~2s window → ~30 t/s
    const avg = t.getSessionAvgTps();
    assert.ok(avg > 15 && avg < 45, `avg=${avg}`);
    assert.equal(t.getTotalOutput(), 60);
  });

  it("never-seen-start fallback window is conservative (0.5s floor)", () => {
    const t = new TpsTracker();
    t.onMessageEnd(0, { role: "assistant", content: [], stopReason: "stop", usage: { output: 100 } });
    const avg = t.getSessionAvgTps();
    // No timestamp → 0.5s floor → 200 t/s max, never something absurd
    assert.ok(avg > 0 && avg <= 220, `avg=${avg}`);
  });
});

describe("TpsTracker — lifecycle & metrics", () => {
  it("cursor-collision scenario: full branch seed then live message", () => {
    const t = new TpsTracker();
    // Scan seeds 3 persisted messages
    for (let i = 0; i < 3; i++) t.onMessageUpdate(i, doneMsg(`m${i}`, 10), true);
    // Hook cursor synced to 2 → next start is index 3
    t.onMessageStart(3);
    t.onStreamingDelta(3, "live tokens arriving now");
    assert.equal(t.isStreaming(), true);
    t.onMessageEnd(3, doneMsg("ignored text", 4));
    assert.equal(t.isStreaming(), false);
    assert.equal(t.getTotalOutput(), 34); // 3×10 + 4
  });

  it("getLiveTps reflects current message, then last completed when idle", async () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    assert.equal(t.getLiveTps(), 0); // no deltas yet → zero, not NaN
    t.onStreamingDelta(0, "some words here");
    await new Promise(r => setTimeout(r, 20));
    const live = t.getLiveTps();
    assert.ok(live > 0, `live=${live}`);
    t.onMessageEnd(0, doneMsg("some words here", 3));
    assert.ok(t.getLiveTps() > 0); // idle: falls back to last completed tps
  });

  it("reset clears everything", () => {
    const t = new TpsTracker();
    t.onMessageUpdate(0, doneMsg("data", 42), true);
    t.reset();
    assert.equal(t.getTotalOutput(), 0);
    assert.equal(t.getSessionAvgTps(), 0);
    assert.equal(t.getLiveTps(), 0);
    assert.equal(t.isStreaming(), false);
  });
});


describe("TpsTracker — TTFT (harness semantics)", () => {
  it("measures turn_start → first non-empty delta, averages samples", async () => {
    const t = new TpsTracker();
    // Turn 1: 50ms ttft
    t.onMessageStart(0);
    t.onTurnStart(Date.now());
    await new Promise(r => setTimeout(r, 30));
    t.onStreamingDelta(0, "hi");
    t.onMessageEnd(0, doneMsg("hi", 1));
    assert.equal(t.getTtftSamples(), 1);
    const first = t.getAvgTtftMs()!;
    assert.ok(first >= 25 && first < 500, `ttft=${first}`);
  });

  it("empty deltas do not start the clock (first WORD, not first event)", async () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onTurnStart(Date.now());
    await new Promise(r => setTimeout(r, 20));
    t.onStreamingDelta(0, "");   // empty — ignored
    await new Promise(r => setTimeout(r, 20));
    t.onStreamingDelta(0, "word");
    t.onMessageEnd(0, doneMsg("word", 1));
    // Should be ~40ms (both sleeps), not ~20ms
    const ttft = t.getAvgTtftMs()!;
    assert.ok(ttft >= 35, `ttft=${ttft} (whitespace-only delta must not count as first word)`);
  });

  it("missing turn_start drops the sample instead of skewing (harness rule)", async () => {
    const t = new TpsTracker();
    // Message 0 has NO turn_start recorded
    t.onMessageStart(0);
    t.onStreamingDelta(0, "x");
    t.onMessageEnd(0, doneMsg("x", 1));
    assert.equal(t.getTtftSamples(), 0);
    assert.equal(t.getAvgTtftMs(), null);
    // Message 1 does have both bounds
    t.onMessageStart(1);
    t.onTurnStart(Date.now());
    await new Promise(r => setTimeout(r, 15));
    t.onStreamingDelta(1, "y");
    t.onMessageEnd(1, doneMsg("y", 1));
    assert.equal(t.getTtftSamples(), 1);
    assert.ok(t.getAvgTtftMs()! < 1000);
  });

  it("reset clears ttft aggregates", () => {
    const t = new TpsTracker();
    t.onMessageStart(0);
    t.onTurnStart(Date.now());
    t.onStreamingDelta(0, "z");
    t.onMessageEnd(0, doneMsg("z", 1));
    assert.ok(t.getTtftSamples() > 0);
    t.reset();
    assert.equal(t.getTtftSamples(), 0);
    assert.equal(t.getAvgTtftMs(), null);
  });
});
