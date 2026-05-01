/**
 * @pi-unipi/footer — TPS (Tokens Per Second) tracker
 *
 * Per-message TPS calculation for live generation rate display.
 * Tracks individual assistant messages with start/stop timestamps
 * to measure generation rate excluding idle/tool-execution time.
 */

/** Per-message TPS record */
interface MessageTpsRecord {
  /** Message index in the session */
  messageIndex: number;
  /** Output tokens for this message */
  outputTokens: number;
  /** When generation started (Date.now()) */
  startedAt: number;
  /** When generation completed (Date.now()), 0 if still generating */
  completedAt: number;
  /** Computed TPS for this message */
  tps: number;
}

/**
 * Tracks per-message TPS and computes live/session metrics.
 *
 * Usage: Call `onMessageUpdate()` whenever output tokens change.
 * The tracker records generation start/stop per message and computes
 * live TPS from the current message and session averages excluding idle time.
 */
export class TpsTracker {
  /** Per-message records */
  private records: MessageTpsRecord[] = [];

  /** Highest message index seen so far (for dedup) */
  private lastSeenMessageCount = 0;

  /** Total output tokens across all completed messages */
  private totalOutput = 0;

  /**
   * Update with the latest message data from the session.
   * Call this on every tick (e.g. 1s interval) with the current state.
   *
   * @param messageIndex - Index of the assistant message (0-based, sequential)
   * @param outputTokens - Output tokens for this message
   * @param hasStopReason - Whether this message has completed (has stopReason)
   */
  onMessageUpdate(messageIndex: number, outputTokens: number, hasStopReason: boolean): void {
    const now = Date.now();

    // New message — create a record
    if (messageIndex >= this.records.length) {
      // Fill gaps if indices jump
      while (this.records.length < messageIndex) {
        this.records.push({
          messageIndex: this.records.length,
          outputTokens: 0,
          startedAt: 0,
          completedAt: 0,
          tps: 0,
        });
      }

      if (hasStopReason && outputTokens > 0) {
        // Fast message: already completed on first sighting
        // Estimate duration: floor of 1 second, or outputTokens/100, whichever is smaller
        const estimatedDuration = Math.max(1, outputTokens / 100);
        const tps = outputTokens / estimatedDuration;

        this.records.push({
          messageIndex,
          outputTokens,
          startedAt: now - estimatedDuration * 1000,
          completedAt: now,
          tps,
        });
        this.totalOutput += outputTokens;
      } else {
        // Just started — mark start time
        this.records.push({
          messageIndex,
          outputTokens,
          startedAt: now,
          completedAt: 0,
          tps: 0,
        });
      }
      this.lastSeenMessageCount = messageIndex + 1;
      return;
    }

    // Update existing message
    const record = this.records[messageIndex];
    if (!record) return;

    record.outputTokens = outputTokens;

    if (record.completedAt === 0 && hasStopReason) {
      // Message just completed
      record.completedAt = now;
      const durationSec = (record.completedAt - record.startedAt) / 1000;
      record.tps = durationSec > 0 ? outputTokens / durationSec : outputTokens;
      this.totalOutput += outputTokens;
    } else if (record.completedAt === 0) {
      // Still generating — update output tokens (live TPS computed on demand)
    }
  }

  /**
   * Get the live TPS from the currently generating message.
   * Returns the instantaneous rate based on tokens generated so far
   * in the current message divided by elapsed time.
   */
  getLiveTps(): number {
    // Find the last record that's still generating
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record.completedAt === 0 && record.startedAt > 0) {
        // Currently generating
        const elapsedSec = (Date.now() - record.startedAt) / 1000;
        if (elapsedSec <= 0) return 0;
        return record.outputTokens / elapsedSec;
      }
    }
    // No active generation — return the last completed message's TPS
    if (this.records.length > 0) {
      const last = this.records[this.records.length - 1];
      return last.tps;
    }
    return 0;
  }

  /**
   * Get the session average TPS, excluding idle/tool-execution time.
   * Computed as total output tokens / total generation time.
   */
  getSessionAvgTps(): number {
    let totalTokens = 0;
    let totalDurationSec = 0;

    for (const record of this.records) {
      if (record.completedAt > 0 && record.startedAt > 0) {
        totalTokens += record.outputTokens;
        totalDurationSec += (record.completedAt - record.startedAt) / 1000;
      }
    }

    // Include currently generating message in average
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].completedAt === 0 && this.records[i].startedAt > 0) {
        totalTokens += this.records[i].outputTokens;
        totalDurationSec += (Date.now() - this.records[i].startedAt) / 1000;
        break;
      }
    }

    if (totalDurationSec <= 0) return 0;
    return totalTokens / totalDurationSec;
  }

  /**
   * Whether the model is currently streaming tokens.
   * True if the latest message has started but not completed.
   */
  isStreaming(): boolean {
    if (this.records.length === 0) return false;
    const last = this.records[this.records.length - 1];
    return last.startedAt > 0 && last.completedAt === 0;
  }

  /**
   * Whether the model was recently generating tokens.
   * Kept for backward compatibility with renderer.
   */
  isGenerating(): boolean {
    return this.isStreaming();
  }

  /**
   * Get total output tokens for the session.
   */
  getTotalOutput(): number {
    // Include tokens from incomplete messages too
    let total = this.totalOutput;
    for (const record of this.records) {
      if (record.completedAt === 0 && record.startedAt > 0) {
        total += record.outputTokens;
      }
    }
    return total;
  }

  /**
   * Reset the tracker (e.g., on session shutdown).
   */
  reset(): void {
    this.records = [];
    this.lastSeenMessageCount = 0;
    this.totalOutput = 0;
  }
}

/** Singleton TPS tracker instance */
export const tpsTracker = new TpsTracker();
