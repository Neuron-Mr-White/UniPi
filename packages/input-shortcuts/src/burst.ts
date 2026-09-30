/**
 * Typing-burst tracker for the undo history.
 *
 * The terminal-input handler must stay O(1): NO editor read per key except
 * at burst start (which captures the pre-burst state, including programmatic
 * changes like submit clearing the editor). Every input only stamps
 * `lastInputAt`. One timer rides along: when it fires, an active burst that
 * went quiet for BURST_IDLE_MS is flushed (post-burst state recorded) and
 * closed; a burst that keeps going longer than BURST_MAX_MS is split so a
 * long typing session still checkpoints. So a burst costs exactly two editor
 * reads — one at open, one at close.
 *
 * Clock, timer and text access are injectable so tests can fake all of them.
 */

export const BURST_IDLE_MS = 600;
export const BURST_MAX_MS = 2000;

export interface BurstDeps {
  /** Read the editor text (called only at burst open and close). */
  getText(): string;
  /** Where the captured states go (EditHistory.record). */
  record(text: string): void;
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class BurstTracker {
  private open = false;
  private burstStart = 0;
  private lastInputAt = 0;
  private timer: unknown = null;

  constructor(private readonly deps: BurstDeps) {}

  /** A terminal input arrived — O(1), no editor read once a burst is open. */
  onInput(): void {
    const now = this.deps.now();
    if (!this.open) {
      this.open = true;
      this.burstStart = now;
      this.lastInputAt = now;
      this.deps.record(this.deps.getText());
      this.arm(now);
      return;
    }
    this.lastInputAt = now;
  }

  /**
   * Flush and close the burst if one is open: the post-burst text is
   * recorded (a no-op when nothing changed). Undo/redo call this first so
   * un-flushed typing is captured before stepping.
   */
  close(): void {
    const wasOpen = this.open;
    this.cancel();
    if (wasOpen) {
      this.deps.record(this.deps.getText());
    }
  }

  /** Drop the timer and forget the burst WITHOUT recording anything. */
  cancel(): void {
    if (this.timer !== null) {
      this.deps.clearTimeout(this.timer);
      this.timer = null;
    }
    this.open = false;
  }

  private arm(now: number): void {
    const idleRemainder = BURST_IDLE_MS - (now - this.lastInputAt);
    const burstRemainder = BURST_MAX_MS - (now - this.burstStart);
    const wait = Math.max(0, Math.min(idleRemainder, burstRemainder));
    this.timer = this.deps.setTimeout(() => this.onTimer(), wait);
  }

  private onTimer(): void {
    const now = this.deps.now();
    if (this.open && now - this.lastInputAt < BURST_IDLE_MS && now - this.burstStart < BURST_MAX_MS) {
      this.arm(now);
      return;
    }
    this.close();
  }
}
