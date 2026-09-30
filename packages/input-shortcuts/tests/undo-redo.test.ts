/**
 * Unit tests for EditHistory — the linear checkpoint list behind undo/redo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EditHistory, MAX_CHARS, MAX_STATES } from "../src/undo-redo.ts";

describe("EditHistory", () => {
  it("records, undoes and redoes linearly", () => {
    const h = new EditHistory();
    h.record("");
    h.record("a");
    h.record("ab");

    assert.deepEqual(h.undo("ab"), { text: "a", ok: true });
    assert.deepEqual(h.undo("a"), { text: "", ok: true });
    assert.equal(h.undo("").ok, false);
    assert.equal(h.undo("").reason, "nothing to undo");

    assert.deepEqual(h.redo(""), { text: "a", ok: true });
    assert.deepEqual(h.redo("a"), { text: "ab", ok: true });
    assert.equal(h.redo("ab").ok, false);
    assert.equal(h.redo("ab").reason, "nothing to redo");
  });

  it("recording the same state twice is a no-op (dedupe)", () => {
    const h = new EditHistory();
    h.record("same");
    h.record("same");
    h.record("same");
    assert.equal(h.undo("same").ok, false, "only one state exists — nothing before it");

    h.record("same");
    h.record("other");
    // The deduped records did not push extra states.
    assert.deepEqual(h.undo("other"), { text: "same", ok: true });
  });

  it("a new edit truncates the redo tail", () => {
    const h = new EditHistory();
    h.record("");
    h.record("one");
    assert.ok(h.undo("one").ok);
    // User edits instead of redoing.
    h.record("one!");
    assert.equal(h.redo("one!").ok, false, "redo invalidated by the edit");
    assert.deepEqual(h.undo("one!"), { text: "", ok: true });
  });

  it("undo records the current text first (captures un-flushed typing)", () => {
    const h = new EditHistory();
    h.record("committed");
    // The user typed more since the last checkpoint; no record() call happened.
    assert.deepEqual(h.undo("committed plus typing"), { text: "committed", ok: true });
    // The un-flushed state is now in the history: redo returns to it.
    assert.deepEqual(h.redo("committed"), { text: "committed plus typing", ok: true });
  });

  it("a flush of the restored text does not destroy the redo", () => {
    const h = new EditHistory();
    h.record("");
    h.record("hello");
    assert.ok(h.undo("hello").ok); // now showing ""
    assert.deepEqual(h.redo(""), { text: "hello", ok: true });
    // The burst flush fires afterwards with the restored text — a no-op.
    h.record("hello");
    assert.equal(h.redo("hello").ok, false, "redo was consumed, not destroyed");
    assert.deepEqual(h.undo("hello"), { text: "", ok: true });
    assert.deepEqual(h.redo(""), { text: "hello", ok: true });
  });

  it("evicts oldest states beyond the count cap", () => {
    const h = new EditHistory();
    for (let i = 0; i <= MAX_STATES; i++) {
      h.record(`state ${i}`);
    }
    // states 0..MAX_STATES = MAX_STATES+1 entries → state 0 evicted.
    let current = `state ${MAX_STATES}`;
    let steps = 0;
    for (;;) {
      const result = h.undo(current);
      if (!result.ok) break;
      current = result.text;
      steps += 1;
    }
    assert.equal(steps, MAX_STATES - 1, "oldest checkpoint evicted, newest kept");
    assert.equal(current, "state 1");
  });

  it("evicts by character budget, not just count", () => {
    const h = new EditHistory();
    // Three ~0.9M states: the second pair fits, the third busts the budget.
    const chunk = "x".repeat(900_000);
    h.record(chunk);
    h.record(chunk + "a");
    h.record(chunk + "b");
    let current = chunk + "b";
    const first = h.undo(current);
    assert.ok(first.ok, "newest predecessor survives");
    assert.equal(first.text, chunk + "a");
    assert.equal(h.undo(first.text).ok, false, "the oldest state was evicted by the char budget");

    // A single huge state is always kept (the newest survives).
    const lone = new EditHistory();
    lone.record("x".repeat(MAX_CHARS + 10));
    assert.equal(lone.undo("x".repeat(MAX_CHARS + 10)).ok, false);
  });

  it("clear() resets everything", () => {
    const h = new EditHistory();
    h.record("something");
    h.clear();
    assert.equal(h.undo("something").ok, false);
    assert.equal(h.redo("something").ok, false);
  });
});
