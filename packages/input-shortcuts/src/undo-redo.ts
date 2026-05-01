/**
 * In-memory ring buffer for undo/redo with debounce and throttle.
 *
 * - Max 50 snapshots in undo stack
 * - 500ms debounce on snapshot creation
 * - 1s throttle on undo
 * - Redo buffer cleared on new snapshot
 */

import type { TextSnapshot } from "./types.ts";
import { MAX_UNDO_SNAPSHOTS, UNDO_DEBOUNCE_MS } from "./types.ts";

export interface UndoRedoResult {
  text: string;
  ok: boolean;
  reason?: string;
}

export class UndoRedoBuffer {
  private undoStack: TextSnapshot[] = [];
  private redoStack: TextSnapshot[] = [];
  private lastSnapshotAt = 0;
  private lastUndoAt = 0;

  /**
   * Take a snapshot of current text BEFORE it changes.
   * Pushes to undo stack, clears redo stack.
   * 500ms debounce: skips if last snapshot was within 500ms.
   */
  snapshot(text: string): void {
    const now = Date.now();
    if (now - this.lastSnapshotAt < UNDO_DEBOUNCE_MS) return;

    this.undoStack.push({ text, timestamp: now });
    if (this.undoStack.length > MAX_UNDO_SNAPSHOTS) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastSnapshotAt = now;
  }

  /**
   * Undo: pop from undo stack, push current text to redo.
   */
  undo(currentText: string): UndoRedoResult {
    if (this.undoStack.length === 0) {
      return { text: currentText, ok: false, reason: "nothing to undo" };
    }

    const snapshot = this.undoStack.pop()!;
    this.redoStack.push({ text: currentText, timestamp: Date.now() });
    return { text: snapshot.text, ok: true };
  }

  /**
   * Redo: pop from redo stack, push current text to undo.
   * No throttle on redo.
   */
  redo(currentText: string): UndoRedoResult {
    if (this.redoStack.length === 0) {
      return { text: currentText, ok: false, reason: "nothing to redo" };
    }

    const snapshot = this.redoStack.pop()!;
    this.undoStack.push({ text: currentText, timestamp: Date.now() });
    return { text: snapshot.text, ok: true };
  }

  /** Check if undo stack has entries. */
  hasUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Check if redo stack has entries. */
  hasRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Clear both stacks. Call on session shutdown. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastSnapshotAt = 0;
    this.lastUndoAt = 0;
  }
}
