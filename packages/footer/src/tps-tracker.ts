/**
 * @pi-unipi/footer — TPS (Tokens Per Second) tracker
 *
 * Sliding-window TPS calculation for live generation rate display.
 * Maintains a rolling buffer of token events for live TPS and
 * cumulative totals for session average.
 */

/** A single token event in the sliding buffer */
interface TokenEvent {
  /** Timestamp of the event (Date.now()) */
  timestamp: number;
  /** Cumulative output token count at this event */
  cumulativeOutput: number;
}

/** Sliding window duration in milliseconds */
const WINDOW_MS = 3000;

/** Time since last event to consider generation "idle" */
const IDLE_THRESHOLD_MS = 2000;

/**
 * Tracks output token events and computes TPS metrics.
 *
 * Usage: Call `onTokenEvent()` whenever output tokens change.
 * The tracker maintains a sliding 3-second window for live TPS
 * and cumulative totals for session average.
 */
export class TpsTracker {
  /** Sliding buffer of token events (kept within WINDOW_MS) */
  private buffer: TokenEvent[] = [];

  /** Total output tokens for the session */
  private totalOutput = 0;

  /** Session start timestamp */
  private sessionStart = 0;

  /** Previous cumulative output (to detect deltas) */
  private lastCumulativeOutput = 0;

  /** Whether the session has started */
  private started = false;

  /**
   * Record a token event. Call this when output token count changes.
   * @param timestamp Current time (Date.now())
   * @param cumulativeOutput Total output tokens so far
   */
  onTokenEvent(timestamp: number, cumulativeOutput: number): void {
    if (!this.started) {
      this.started = true;
      this.sessionStart = timestamp;
    }

    // Only record if there's actual new output
    if (cumulativeOutput <= this.lastCumulativeOutput) return;

    const delta = cumulativeOutput - this.lastCumulativeOutput;
    this.totalOutput += delta;
    this.lastCumulativeOutput = cumulativeOutput;

    this.buffer.push({ timestamp, cumulativeOutput });
    this.evictOld(timestamp);
  }

  /**
   * Get the live TPS rate from the sliding window.
   * Returns 0 if not enough data.
   */
  getLiveTps(): number {
    const now = Date.now();
    this.evictOld(now);

    if (this.buffer.length < 2) return 0;

    const oldest = this.buffer[0];
    const newest = this.buffer[this.buffer.length - 1];
    const timeDeltaSec = (newest.timestamp - oldest.timestamp) / 1000;

    if (timeDeltaSec <= 0) return 0;

    const tokenDelta = newest.cumulativeOutput - oldest.cumulativeOutput;
    return tokenDelta / timeDeltaSec;
  }

  /**
   * Get the session average TPS.
   * Returns 0 if session hasn't started or no time has elapsed.
   */
  getSessionAvgTps(): number {
    if (!this.started) return 0;

    const elapsedSec = (Date.now() - this.sessionStart) / 1000;
    if (elapsedSec <= 0) return 0;

    return this.totalOutput / elapsedSec;
  }

  /**
   * Whether the model is currently generating tokens.
   * True if there are events within the last 2 seconds.
   */
  isGenerating(): boolean {
    if (this.buffer.length === 0) return false;
    const lastEvent = this.buffer[this.buffer.length - 1];
    return (Date.now() - lastEvent.timestamp) < IDLE_THRESHOLD_MS;
  }

  /**
   * Get total output tokens for the session.
   */
  getTotalOutput(): number {
    return this.totalOutput;
  }

  /**
   * Reset the tracker (e.g., on session shutdown).
   */
  reset(): void {
    this.buffer = [];
    this.totalOutput = 0;
    this.sessionStart = 0;
    this.lastCumulativeOutput = 0;
    this.started = false;
  }

  /**
   * Evict events older than WINDOW_MS from the buffer.
   */
  private evictOld(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
      this.buffer.shift();
    }
  }
}

/** Singleton TPS tracker instance */
export const tpsTracker = new TpsTracker();
