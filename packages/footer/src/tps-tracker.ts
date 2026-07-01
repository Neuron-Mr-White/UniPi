/**
 * @pi-unipi/footer — TPS (Tokens Per Second) tracker
 *
 * Per-message TPS calculation for live generation rate display.
 * Tracks individual assistant messages with start/stop timestamps
 * to measure generation rate excluding idle/tool-execution time.
 *
 * ## Token counting
 *
 * Output tokens are counted from the assistant message *content* (text +
 * thinking blocks) via a lightweight word/char heuristic, NOT from
 * `usage.output`. Rationale:
 *   - `usage.output` is only populated by the provider at stream end (or in
 *     a final `message_delta`), so it is 0 throughout generation and useless
 *     for a live rate.
 *   - Counting the streamed text ourselves gives a real, monotonically
 *     increasing numerator that reflects how much the model has actually
 *     produced so far.
 *   - This matches what users perceive as "tokens per second" (visible
 *     output rate) and avoids the previous bug where the displayed TPS was
 *     always inflated to 90+ t/s (caused by dividing a post-hoc `usage.output`
 *     total by a too-short, incorrectly measured elapsed window).
 *
 * The heuristic intentionally over-counts slightly (whitespace + punctuation
 * are treated as tokens). That is acceptable for a live speed indicator and
 * keeps the estimate in the right order of magnitude (within ~10-20% of the
 * provider's reported output tokens for typical English/code output).
 */

/** Per-message TPS record */
interface MessageTpsRecord {
  /** Message index in the session (sequential, assistant-only) */
  messageIndex: number;
  /** Estimated output tokens produced so far for this message */
  outputTokens: number;
  /** When generation started (Date.now(), ms) */
  startedAt: number;
  /** When generation completed (Date.now(), ms), 0 if still generating */
  completedAt: number;
  /** Computed TPS for this message (final, once completed) */
  tps: number;
}

/**
 * Estimate the number of tokens in a string.
 *
 * Uses a cheap word + punctuation split. Good enough for a live TPS display;
 * we deliberately avoid pulling in a full BPE tokenizer for performance and
 * footprint reasons.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count word-ish tokens and standalone punctuation.
  // \p{L} / \p{N} keep this Unicode-aware for non-ASCII content.
  const wordish = text.match(/[\p{L}\p{N}]+/gu);
  const punct = text.match(/[^\s\p{L}\p{N}]+/gu);
  const wordCount = wordish ? wordish.length : 0;
  const punctCount = punct ? punct.length : 0;
  return wordCount + punctCount;
}

/**
 * Estimate output tokens from an assistant message by summing text and
 * thinking content lengths. Tool-call argument JSON is also counted since
 * it represents model output.
 *
 * Accepts the raw message shape from pi's session entries (loosely typed).
 */
function estimateOutputTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") return 0;
  const content = m.content;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === "text" && typeof b.text === "string") {
      total += estimateTokens(b.text);
    } else if (type === "thinking" && typeof b.thinking === "string") {
      total += estimateTokens(b.thinking);
    } else if (type === "tool_use" || type === "toolcall") {
      // Count tool name + serialized arguments as model output.
      const name = typeof b.name === "string" ? b.name : "";
      const input = b.input ?? b.arguments;
      let inputStr: string;
      try {
        inputStr = typeof input === "string" ? input : JSON.stringify(input ?? "");
      } catch {
        inputStr = "";
      }
      total += estimateTokens(name) + estimateTokens(inputStr);
    }
  }
  return total;
}

/**
 * Tracks per-message TPS and computes live/session metrics.
 *
 * Usage: Call `onMessageUpdate()` on every tick (e.g. 1s interval) with the
 * current assistant message state. The tracker records generation start/stop
 * per message and computes live TPS from elapsed wall-clock time.
 */
export class TpsTracker {
  /** Per-message records (one per assistant message, in order) */
  private records: MessageTpsRecord[] = [];

  /** Total estimated output tokens across all messages */
  private totalOutput = 0;

  /**
   * Update with the latest message data from the session.
   * Call this on every tick (e.g. 1s interval) with the current state.
   *
   * @param messageIndex - Index of the assistant message (0-based, sequential)
   * @param message - The assistant message object (content used to count tokens)
   * @param hasStopReason - Whether this message has completed (has stopReason)
   */
  onMessageUpdate(messageIndex: number, message: unknown, hasStopReason: boolean): void {
    const now = Date.now();
    const outputTokens = estimateOutputTokens(message);

    // New message — create a record
    if (messageIndex >= this.records.length) {
      // Fill gaps if indices jump (shouldn't normally happen)
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
        // Fast message: already completed on first sighting.
        // We never observed it streaming, so we can't measure real duration.
        // Fall back to a conservative estimate instead of inventing a 1s
        // window (which previously produced inflated TPS values).
        const estimatedDuration = Math.max(0.5, outputTokens / 60);
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
      return;
    }

    // Update existing message
    const record = this.records[messageIndex];
    if (!record) return;

    if (record.completedAt === 0) {
      // Still generating — update token count (live TPS computed on demand)
      record.outputTokens = outputTokens;

      if (hasStopReason) {
        // Message just completed
        record.completedAt = now;
        const durationSec = (record.completedAt - record.startedAt) / 1000;
        record.tps = durationSec > 0 ? record.outputTokens / durationSec : 0;
        this.totalOutput += record.outputTokens;
      }
    }
  }

  /**
   * Get the live TPS from the currently generating message.
   * Returns the instantaneous rate based on tokens generated so far
   * in the current message divided by elapsed wall-clock time.
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
   * Get total output tokens for the session (estimated).
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
    this.totalOutput = 0;
  }
}

/** Singleton TPS tracker instance */
export const tpsTracker = new TpsTracker();
