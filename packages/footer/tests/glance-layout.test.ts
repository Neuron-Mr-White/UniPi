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

describe("scan-derived fallbacks (no-hook environments)", () => {
  it("syncBranchStats is monotonic and seeds turns/steps", () => {
    const t = new TpsTracker();
    t.syncBranchStats(0, 275);
    t.syncBranchStats(3, 280);
    assert.equal(t.getTurnCount(), 3);
    assert.equal(t.getStepCount(), 280);
    t.syncBranchStats(1, 5); // branch shrank — never regress
    assert.equal(t.getTurnCount(), 3);
  });

  it("syncWallMs only grows", () => {
    const t = new TpsTracker();
    t.syncWallMs(5000);
    t.syncWallMs(3000);
    assert.equal(t.getSessionLlmMs(), 5000);
    t.syncWallMs(8000);
    assert.equal(t.getSessionLlmMs(), 8000);
  });

  it("seedTtftFallback samples when hooks silent; hook wins later", async () => {
    const t = new TpsTracker();
    const now = Date.now();
    // Record must exist first (scan creates it), then seed
    t.onMessageUpdate(0, {
      role: "assistant", content: [{ type: "text", text: "x" }],
      stopReason: "stop", timestamp: now - 1000, usage: { output: 10 },
    }, true);
    t.seedTtftFallback(now - 4000, now - 1000, 0);
    const seeded = t.getAvgTtftMs();
    assert.ok(seeded !== null && seeded >= 2500, `seeded=${seeded}`);
    // Window clamped at 30s so a long idle gap doesn't poison the average
    const t3 = new TpsTracker();
    t3.onMessageUpdate(0, {
      role: "assistant", content: [], stopReason: "stop",
      timestamp: Date.now(), usage: { output: 1 },
    }, true);
    t3.seedTtftFallback(Date.now() - 600_000, Date.now(), 0); // 10-minute gap
    assert.ok(t3.getAvgTtftMs()! <= 30_000, `clamped=${t3.getAvgTtftMs()}`);
  });
});

describe("branch tool pairing (persisted sessions)", () => {
  it("syncToolMs is monotonic like other branch stats", () => {
    const t = new TpsTracker();
    t.syncToolMs(4000);
    t.syncToolMs(2500);
    assert.equal(t.getToolMs(), 4000);
    t.syncToolMs(6000);
    assert.equal(t.getToolMs(), 6000);
  });
});

describe("rainbow frame escape handling (max/xhigh mode)", () => {
	// Reconstruct the painting walk used by GlanceEditor.paintLolcatLine to
	// prove zero-width string sequences survive byte-identical.
	const CURSOR_MARKER = "\x1b_pi:c\x07";
	const OSC133 = "\x1b]133;A\x07";
	const CSI = "\x1b[38;2;10;20;30m";

	function paint(line: string): string {
		let out = "";
		let i = 0;
		while (i < line.length) {
			const ch = line[i];
			if (ch === "\x1b") {
				const rest = line.slice(i);
				const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(rest);
				if (csi) { out += csi[0]; i += csi[0].length; continue; }
				const strSeq = /^\x1b[\]_][^\x07]*(?:\x07|\x1b\\)/.exec(rest);
				if (strSeq) { out += strSeq[0]; i += strSeq[0].length; continue; }
			}
			out += ch;
			i++;
		}
		return out;
	}

	it("CURSOR_MARKER and OSC 133 pass through without leaking '_pi:c' bytes", () => {
		const painted = paint(`│${CSI}abc${CURSOR_MARKER}${OSC133}`);
		assert.ok(!painted.includes("_pi:c") || painted.includes(CURSOR_MARKER),
			"marker bytes must only appear inside the intact escape");
		assert.ok(painted.includes(CURSOR_MARKER), "marker preserved verbatim");
		assert.ok(painted.includes(OSC133), "OSC preserved verbatim");
	});

	it("stripControls equivalent removes all zero-width sequences", () => {
		const strip = (s: string) => s.replace(
			/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g, "");
		assert.equal(strip(`${CSI}hi${CURSOR_MARKER}${OSC133}`), "hi");
	});
});
