/**
 * Linear checkpoint history for the editor.
 *
 * `states` is the ordered list of editor texts and `index` points at the
 * current one; undo steps back, redo steps forward. `record` is idempotent
 * for the current state, so a flush that re-records the text an undo just
 * restored is a no-op — no suppress flags needed.
 *
 * Memory is bounded two ways: at most MAX_STATES checkpoints and at most
 * MAX_CHARS characters in total (oldest evicted first, running char total,
 * O(1) amortized per operation).
 */

export const MAX_STATES = 100;
export const MAX_CHARS = 2_000_000;

export interface HistoryResult {
  text: string;
  ok: boolean;
  reason?: string;
}

export class EditHistory {
  private states: string[] = [];
  private index = -1;
  private chars = 0;

  /** Commit `text` as the current state. No-op when it did not change. */
  record(text: string): void {
    if (this.index >= 0 && this.states[this.index] === text) return;
    // Anything after the current state was redone-able — a new edit kills it.
    for (let i = this.index + 1; i < this.states.length; i++) {
      this.chars -= this.states[i]!.length;
    }
    this.states.length = this.index + 1;
    this.states.push(text);
    this.chars += text.length;
    this.index = this.states.length - 1;
    this.evict();
  }

  /**
   * Step back. `current` is recorded first so un-flushed typing since the
   * last burst is not lost — then the previous state is returned.
   */
  undo(current: string): HistoryResult {
    this.record(current);
    if (this.index <= 0) {
      return { text: current, ok: false, reason: "nothing to undo" };
    }
    this.index -= 1;
    return { text: this.states[this.index]!, ok: true };
  }

  /**
   * Step forward. An edit after an undo invalidates the redo: `current`
   * no longer matches the state we are sitting on, so record it and fail.
   */
  redo(current: string): HistoryResult {
    const at = this.index >= 0 ? this.states[this.index] : undefined;
    if (current !== at) {
      this.record(current);
      return { text: current, ok: false, reason: "nothing to redo" };
    }
    if (this.index >= this.states.length - 1) {
      return { text: current, ok: false, reason: "nothing to redo" };
    }
    this.index += 1;
    return { text: this.states[this.index]!, ok: true };
  }

  /** Drop everything. Call on session shutdown. */
  clear(): void {
    this.states = [];
    this.index = -1;
    this.chars = 0;
  }

  private evict(): void {
    while (this.states.length > 1 && (this.states.length > MAX_STATES || this.chars > MAX_CHARS)) {
      this.chars -= this.states[0]!.length;
      this.states.shift();
      this.index -= 1;
    }
  }
}
