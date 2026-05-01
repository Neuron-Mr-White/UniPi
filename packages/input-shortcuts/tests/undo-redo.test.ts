/**
 * Unit tests for UndoRedoBuffer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UndoRedoBuffer } from "../src/undo-redo.ts";

describe("UndoRedoBuffer", () => {
  it("basic undo/redo roundtrip", () => {
    const buf = new UndoRedoBuffer();

    buf.snapshot("first");
    // Reset debounce for test
    (buf as any).lastSnapshotAt = 0;
    buf.snapshot("second");

    const undo1 = buf.undo("current");
    assert.equal(undo1.ok, true);
    assert.equal(undo1.text, "second");

    const undo2 = buf.undo("second");
    assert.equal(undo2.ok, true);
    assert.equal(undo2.text, "first");

    // Nothing more to undo
    const undo3 = buf.undo("first");
    assert.equal(undo3.ok, false);
    assert.equal(undo3.reason, "nothing to undo");

    // Redo
    const redo1 = buf.redo("first");
    assert.equal(redo1.ok, true);
    assert.equal(redo1.text, "second");

    const redo2 = buf.redo("second");
    assert.equal(redo2.ok, true);
    assert.equal(redo2.text, "current");

    // Nothing more to redo
    const redo3 = buf.redo("current");
    assert.equal(redo3.ok, false);
    assert.equal(redo3.reason, "nothing to redo");
  });

  it("redo clears on new snapshot", () => {
    const buf = new UndoRedoBuffer();

    buf.snapshot("a");
    (buf as any).lastSnapshotAt = 0;
    buf.snapshot("b");
    buf.undo("current"); // redo now has "current"

    (buf as any).lastSnapshotAt = 0;
    buf.snapshot("c"); // should clear redo

    const redo = buf.redo("whatever");
    assert.equal(redo.ok, false);
    assert.equal(redo.reason, "nothing to redo");
  });

  it("max size eviction", () => {
    const buf = new UndoRedoBuffer();

    // Push 55 snapshots (max is 50)
    for (let i = 0; i < 55; i++) {
      buf.snapshot(`text-${i}`);
      // Manually reset debounce for testing
      (buf as any).lastSnapshotAt = 0;
    }

    // Undo all — should only get 50
    let count = 0;
    for (let i = 0; i < 60; i++) {
      const result = buf.undo("x");
      if (result.ok) count++;
    }
    assert.equal(count, 50);
  });

  it("clear resets everything", () => {
    const buf = new UndoRedoBuffer();

    buf.snapshot("a");
    buf.snapshot("b");
    buf.undo("current");

    buf.clear();

    assert.equal(buf.hasUndo(), false);
    assert.equal(buf.hasRedo(), false);

    const undo = buf.undo("x");
    assert.equal(undo.ok, false);

    const redo = buf.redo("x");
    assert.equal(redo.ok, false);
  });

  it("debounce prevents rapid snapshots", () => {
    const buf = new UndoRedoBuffer();

    buf.snapshot("first");
    buf.snapshot("second"); // should be debounced

    // Only one snapshot should exist
    const undo = buf.undo("current");
    assert.equal(undo.ok, true);
    assert.equal(undo.text, "first");

    // No more undos
    const undo2 = buf.undo("first");
    assert.equal(undo2.ok, false);
  });

  it("consecutive undos work without throttle", () => {
    const buf = new UndoRedoBuffer();

    buf.snapshot("a");
    (buf as any).lastSnapshotAt = 0;
    buf.snapshot("b");
    (buf as any).lastSnapshotAt = 0;
    buf.snapshot("c");

    // Three consecutive undos should all work
    const undo1 = buf.undo("current");
    assert.equal(undo1.ok, true);
    assert.equal(undo1.text, "c");

    const undo2 = buf.undo("c");
    assert.equal(undo2.ok, true);
    assert.equal(undo2.text, "b");

    const undo3 = buf.undo("b");
    assert.equal(undo3.ok, true);
    assert.equal(undo3.text, "a");
  });

  it("hasUndo/hasRedo reflect stack state", () => {
    const buf = new UndoRedoBuffer();

    assert.equal(buf.hasUndo(), false);
    assert.equal(buf.hasRedo(), false);

    buf.snapshot("a");
    assert.equal(buf.hasUndo(), true);
    assert.equal(buf.hasRedo(), false);

    buf.undo("current");
    assert.equal(buf.hasUndo(), false);
    assert.equal(buf.hasRedo(), true);
  });
});
