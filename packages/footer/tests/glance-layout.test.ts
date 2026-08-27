/**
 * @pi-unipi/footer — v3 glance layout tests
 *
 * New default preset, UNI/directory segments, git adornments,
 * session strip stats (turns/steps/wall/tool/TTFT/tps/cache).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PRESETS, getPreset } from "../src/presets.js";
import { TpsTracker } from "../src/tps-tracker.js";

describe("v3 default preset", () => {
  it("default is UNI > model > thinking > directory > git | ctx/tokens ...", () => {
    const d = PRESETS.default;
    assert.deepEqual(d.leftSegments.slice(0, 3), ["uni", "model", "thinking_level"]);
    assert.ok(d.leftSegments.includes("directory"));
    assert.ok(d.leftSegments.includes("git"));
    for (const id of ["context_pct", "tokens_total"]) {
      assert.ok(d.rightSegments.includes(id), `${id} in right zone`);
    }
  });

  it("classic preset preserves the old balanced view", () => {
    const c = PRESETS.classic;
    assert.deepEqual(c.leftSegments, ["model", "api_state", "tool_count", "git"]);
    assert.equal(getPreset("classic"), c);
  });

  it("unknown preset falls back to default", () => {
    assert.equal(getPreset("nope"), PRESETS.default);
  });

  it("uni + directory segments registered in core segments source", () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/segments/core.ts"), "utf-8");
    assert.match(src, /id: "uni"/);
    assert.match(src, /id: "directory"/);
  });
});

describe("session strip stats (tracker)", () => {
  function doneMsg(text: string, outputTokens: number) {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: { output: outputTokens },
    };
  }

  it("counts turns and steps", async () => {
    const t = new TpsTracker();
    t.onTurnStart(Date.now());
    t.onMessageStart(0);
    t.onStreamingDelta(0, "a");
    t.onMessageEnd(0, doneMsg("a", 1));
    t.onTurnEnd();

    t.onTurnStart(Date.now());
    t.onMessageStart(1);
    t.onStreamingDelta(1, "b");
    t.onMessageEnd(1, doneMsg("b", 1));
    t.onTurnEnd();
    // Second turn may reuse cursor indexes across branch; use unique idx anyway
    assert.equal(t.getTurnCount(), 2);
    assert.ok(t.getStepCount() >= 1);
  });

  it("accumulates wall time on turn end and tool pairs by callId", async () => {
    const t = new TpsTracker();
    t.onTurnStart(Date.now());
    await new Promise(r => setTimeout(r, 20));
    t.onToolCallStart("call-1");
    await new Promise(r => setTimeout(r, 20));
    t.onToolCallEnd("call-1");
    t.onTurnEnd();

    assert.ok(t.getSessionLlmMs() >= 15, `llm=${t.getSessionLlmMs()}`);
    assert.ok(t.getToolMs() >= 15, `tool=${t.getToolMs()}`);
    assert.ok(t.getToolMs() <= t.getSessionLlmMs() + 5);
  });

  it("unmatched tool end is ignored", () => {
    const t = new TpsTracker();
    t.onToolCallEnd("ghost");
    assert.equal(t.getToolMs(), 0);
  });

  it("turn_start is idempotent within an open turn (steps per turn)", () => {
    const t = new TpsTracker();
    t.onTurnStart();
    t.onTurnStart(); // same turn, another step
    t.onTurnStart();
    assert.equal(t.getTurnCount(), 1);
  });
});
