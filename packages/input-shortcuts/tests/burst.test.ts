/**
 * Unit tests for the BurstTracker — two editor reads per burst, injected
 * clock/timer/text so no real time passes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BurstTracker, BURST_IDLE_MS, BURST_MAX_MS } from "../src/burst.ts";
import { EditHistory } from "../src/undo-redo.ts";

/** Deterministic clock + single-timeline timer queue. */
class FakeClock {
  time = 0;
  private timers: Array<{ at: number; fn: () => void }> = [];
  now = (): number => this.time;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const timer = { at: this.time + ms, fn };
    this.timers.push(timer);
    return timer;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((timer) => timer !== handle);
  };
  /** Pass time, firing every timer that comes due (in order). */
  advance(ms: number): void {
    this.time += ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= this.time).sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next) return;
      this.timers = this.timers.filter((timer) => timer !== next);
      next.fn();
    }
  }
}

function setup(texts: string[]) {
  const clock = new FakeClock();
  const reads: number[] = [];
  const history = new EditHistory();
  const tracker = new BurstTracker({
    getText: () => {
      reads.push(clock.time);
      return texts.shift() ?? "";
    },
    record: (text) => history.record(text),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { clock, reads, history, tracker };
}

describe("BurstTracker", () => {
  it("100 keystrokes in one burst cost exactly 2 editor reads", () => {
    // First read: pre-burst state. Second read: post-burst state.
    // 100 keys × 10ms ≈ 1s of typing — inside one burst window.
    const { clock, reads, tracker } = setup(["", "x".repeat(100)]);
    tracker.onInput(); // burst opens — read 1
    for (let i = 1; i < 100; i++) {
      clock.advance(10); // keystrokes every 10ms — no reads, no timer churn
      tracker.onInput();
    }
    assert.equal(reads.length, 1, "no reads while the burst is open");
    clock.advance(BURST_IDLE_MS); // typing stops → flush
    assert.equal(reads.length, 2, "one read at close");
  });

  it("continuous typing for 5s splits the burst roughly every 2s", () => {
    const states = ["", "a", "ab", "abc", "abcd", "abcde", "abcdef"];
    const { clock, reads, tracker } = setup(states);
    tracker.onInput();
    for (let i = 0; i < 50; i++) {
      clock.advance(100); // 5 seconds of steady typing
      tracker.onInput();
    }
    clock.advance(BURST_IDLE_MS);
    // Burst closes at ~2s and ~4s; each close is followed by a re-open read.
    assert.ok(reads.length >= 5, `expected a read per ~2s window, got ${reads.length} reads`);
    assert.ok(reads.length <= 8, `too many reads (${reads.length}) — the burst is churning`);
  });

  it("undo during a burst captures the un-flushed text and keeps redo intact", () => {
    const queue = ["", "typed text"];
    const { clock, history, tracker } = setup(queue);
    tracker.onInput(); // record("")
    clock.advance(100);
    tracker.onInput(); // still typing — nothing recorded yet

    // The undo action: close the burst (flush), then step back.
    tracker.close(); // records "typed text"
    const undone = history.undo("typed text");
    assert.deepEqual(undone, { text: "", ok: true });
    // Editor now shows "". Redo returns the flushed state.
    assert.deepEqual(history.redo(""), { text: "typed text", ok: true });

    // The next real input records the restored text — a dedupe no-op that
    // leaves the (now consumed) history consistent.
    tracker.onInput(); // reads "" — the restored editor text
    clock.advance(BURST_IDLE_MS);
    assert.equal(history.undo("").ok, true);
  });

  it("closing with no open burst reads nothing", () => {
    const { reads, tracker } = setup(["x"]);
    tracker.close();
    tracker.close();
    assert.equal(reads.length, 0);
  });

  it("cancel drops the burst without recording", () => {
    const { reads, history, tracker } = setup(["", "mid-typing"]);
    tracker.onInput();
    tracker.cancel();
    assert.equal(reads.length, 1, "only the open read happened");
    // undo() records the current text itself, so the only state it can reach
    // is the pre-burst one — nothing mid-burst was ever flushed.
    assert.deepEqual(history.undo("mid-typing"), { text: "", ok: true });
  });
});
