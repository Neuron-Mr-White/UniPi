/**
 * @pi-unipi/footer — TPS (Tokens Per Second) tracker
 *
 * Per-message TPS calculation for live generation rate display.
 *
 * ## Token counting (anchored, harness-style)
 *
 * Token sources, best-first — following the deepseek-harness token-meter
 * principle of never fabricating when an exact count exists:
 *
 *   1. Provider-anchored (`anchored`): the exact `usage.output` reported by
 *      the provider at stream end. Truth; replaces any estimate.
 *   2. Density estimate: chars/4 heuristic (deepseek-harness fixed-density
 *      model) over accumulated text/thinking/tool-arg content. Works during
 *      streaming where `usage.output` is still 0. Much cheaper and more
 *      accurate than word counting — especially for CJK, where word regexes
 *      collapse entire paragraphs into one "word" while chars/4 stays within
 *      ~2x for typical Chinese output.
 *
 * While streaming, tokens = density estimate of what has arrived so far.
 * At completion, tokens = provider usage.output (anchor wins). If the
 * provider reports nothing usable, the estimate stands.
 *
 * ## Timing contract (user requirement)
 *
 * Durations measure ONLY output generation: first content → stream end.
 * Tool-execution time, queueing before the first token, and idle time
 * between messages are all excluded:
 *
 *   - startedAt  = arrival of the FIRST streamed delta (not message_start;
 *     excludes TTFT + request overhead), or the provider message timestamp
 *     when a message is only ever seen completed.
 *   - completedAt = stream end (message_end / stopReason sighting).
 *
 * Live TPS = estimated tokens so far ÷ (now − startedAt).
 * Session AVG = Σ anchored/estimated output ÷ Σ per-message generation times.
 */

/** Deepseek-harness fixed text-density estimate. */
const CHARS_PER_TOKEN = 4;

/** Per-message TPS record */
interface MessageTpsRecord {
	/** Branch-local assistant message index */
	messageIndex: number;
	/**
	 * Tokens used for rates. Estimate while streaming; the exact provider
	 * usage.output once completed (0 if the provider reported none).
	 */
	tokens: number;
	/** Density-estimate fallback when the provider reports no usage. */
	estimatedTokens: number;
	/** True once `tokens` holds the exact provider-reported output. */
	anchored: boolean;
	/** Agent turn start (ms) — when generation was requested. 0 if unknown. */
	requestAt: number;
	/** When OUTPUT GENERATION started (ms). First non-empty delta. */
	startedAt: number;
	/** True once a live streaming delta was observed (window is hook-measured). */
	sawFirstDelta: boolean;
	/** When generation completed (ms), 0 if still generating. */
	completedAt: number;
	/**
	 * MEASURED output-only decode window (first delta → stream end, ms).
	 * 0 when never measured — such records are excluded from the session
	 * average (deepseek-harness rule: unmeasurable steps drop out).
	 */
	decodeMs: number;
	/** Final TPS for this message (once completed). */
	tps: number;
}

/**
 * Fixed-density token estimate: chars/4 with structural allowance.
 * Same constant family as deepseek-harness dsh-token-meter's estimator.
 * Unicode-safe: String.length counts UTF-16 units; CJK BMP chars count 1
 * unit each which slightly overprices them toward correctness.
 */
function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Accumulate the density estimate for one streaming delta.
 * Returns the running total length contributed for O(1)-per-delta updates.
 */
function deltaContribution(deltaText: string): number {
	return estimateTokens(deltaText);
}

/**
 * Extract the assistant message timestamp (provider-side start), if present.
 */
function messageTimestamp(message: unknown): number {
	const m = message as Record<string, unknown> | undefined;
	if (!m || typeof m !== "object") return 0;
	return typeof m.timestamp === "number" ? m.timestamp : 0;
}

/**
 * Exact provider-reported output tokens for a completed assistant message,
 * or 0 when absent/error (fall back to the density estimate then).
 */
function providerOutputTokens(message: unknown): number {
	const m = message as Record<string, unknown> | undefined;
	if (!m || typeof m !== "object") return 0;
	const usage = m.usage as Record<string, unknown> | undefined;
	const output = usage?.output;
	return typeof output === "number" && output > 0 ? output : 0;
}

/**
 * Estimate output tokens from message content via the fixed-density model.
 * Counts text, thinking, and tool-call arguments (all model output).
 */
function estimateOutputTokens(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const m = message as Record<string, unknown>;
	if (m.role !== "assistant") return 0;
	const content = m.content;
	if (!Array.isArray(content)) return 0;

	let chars = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		switch (b.type) {
			case "text":
				chars += typeof b.text === "string" ? b.text.length : 0;
				break;
			case "thinking":
				chars += typeof b.thinking === "string" ? b.thinking.length : 0;
				break;
			case "tool_use":
			case "toolcall": {
				let inputStr: string;
				try {
					const input = b.input ?? b.arguments;
					inputStr =
						typeof input === "string"
							? input
							: JSON.stringify(input ?? "");
				} catch {
					inputStr = "";
				}
				chars += inputStr.length;
				break;
			}
		}
	}
	// FIXED: was estimateTokens(String(chars)) — that divided the DIGIT COUNT
	// of the number (String(8000).length === 4) by 4, collapsing an 8000-char
	// response into 1 "token". Divide the actual char count instead.
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Tracks per-message TPS and computes live/session metrics.
 *
 * Writers (both keyed by branch-local assistant index — see index.ts):
 *   - Streaming hooks: onMessageStart / onStreamingDelta / onMessageEnd
 *   - 1s reconciliation scan: onMessageUpdate (snapshot; timing source of
 *     last resort — it stamps startedAt from the persisted record only when
 *     nothing better exists, so a pure-scan environment still works but a
 *     streaming-aware one always measures output-only windows).
 */
export class TpsTracker {
	private records: MessageTpsRecord[] = [];

	/** Total output tokens across COMPLETED messages (anchored when possible). */
	private totalOutput = 0;

	// ── TTFT aggregation (deepseek-harness session-stats semantics) ────────
	/** Summed (firstDelta − turnStart) over completed messages with both bounds. */
	private ttftMs = 0;
	/** Messages that contributed a measurable TTFT sample. */
	private ttftSteps = 0;
	/** TTFT samples recorded by live hooks (as opposed to branch seeds). */
	private ttftHookSamples = 0;

	// ── Session strip stats (harness session-stats: turns/steps/wall/tool) ──
	private turns = 0;
	/** Completed assistant messages (= steps with output). */
	private steps = 0;
	/** Turn-start → agent_settled-ish wall time accumulated per turn (open now). */
	private turnStartAt = 0;
	/** Summed wall time of completed turns. */
	private llmMs = 0;
	/** tool execution start → end pairs matched by index. */
	private pendingTools = new Map<string, number>();
	private toolMs = 0;

	/** Most recent turn_start timestamp — stamped onto records as requestAt. */
	private lastTurnStart = 0;

	/** Pending char-count used to keep density estimates incremental. */
	private pendingChars = new Map<number, number>();

	// ── Streaming-hook API ────────────────────────────────────────────────

	/**
	 * Assistant message begins streaming. Creates the record but does NOT
	 * start the clock — that happens at the first delta (output-only timing).
	 */
	onMessageStart(messageIndex: number): void {
		if (this.records[messageIndex]) return; // re-start of known message
		while (this.records.length < messageIndex) {
			this.records.push({
				messageIndex: this.records.length,
				tokens: 0,
				estimatedTokens: 0,
				anchored: false,
				requestAt: this.lastTurnStart,
				startedAt: 0,
				sawFirstDelta: false,
				completedAt: 0,
			decodeMs: 0,
				tps: 0,
			});
		}
		this.records.push({
			messageIndex,
			tokens: 0,
			estimatedTokens: 0,
			anchored: false,
			// turn_start precedes message_start in pi's event order, so a fresh
			// record inherits the current open-turn start as its TTFT bound.
			requestAt: this.lastTurnStart,
			startedAt: 0,
			sawFirstDelta: false,
			completedAt: 0,
			decodeMs: 0,
			tps: 0,
		});
	}

	/**
	 * The request boundary for this assistant message — pi's turn_start.
	 * Timing authority stays with streaming hooks; this only stamps the TTFT
	 * start bound and never touches startedAt.
	 */
	onTurnStart(timestamp?: number): void {
		const ts = typeof timestamp === "number" && timestamp > 0 ? timestamp : Date.now();
		this.lastTurnStart = ts;
		if (this.turnStartAt === 0) {
			this.turns += 1;
			this.turnStartAt = ts;
		}
		const pending = this.records.find(r => r.completedAt === 0);
		if (!pending || pending.requestAt !== 0) return;
		pending.requestAt = ts;
	}

	/** One streamed delta arrived. Starts the clock on the FIRST NON-EMPTY delta. */
	onStreamingDelta(messageIndex: number, deltaText: string): void {
		const record = this.records[messageIndex];
		if (!record || record.completedAt !== 0) return;
		if (!deltaText) return;
		if (record.startedAt === 0) {
			record.startedAt = Date.now();
			// Harness rule: record one TTFT sample per step ONLY when both
			// bounds exist; steps missing either drop out of the average.
			if (record.requestAt > 0 && record.requestAt <= record.startedAt) {
				this.ttftMs += Math.max(0, record.startedAt - record.requestAt);
				this.ttftSteps += 1;
				this.ttftHookSamples += 1;
			}
		}
		record.sawFirstDelta = true; // window becomes hook-measured
		record.estimatedTokens += deltaContribution(deltaText);
		record.tokens = record.estimatedTokens;
	}

	/** Assistant stream finished. Anchors to provider usage.output. */
	onMessageEnd(messageIndex: number, finalMessage?: unknown): void {
		if (!this.records[messageIndex]) this.onMessageStart(messageIndex);
		const record = this.records[messageIndex];
		if (!record || record.completedAt !== 0) return;
		record.completedAt = Date.now();

		const providerOut = providerOutputTokens(finalMessage);
		if (providerOut > 0) {
			record.tokens = providerOut;
			record.anchored = true;
		} else if (finalMessage && !record.startedAt) {
			record.estimatedTokens = Math.max(
				record.estimatedTokens,
				estimateOutputTokens(finalMessage),
			);
			record.tokens = record.estimatedTokens;
		}
		if (!record.startedAt) {
			// Never saw a delta (ultra-fast or scan-only): fall back to the
			// provider message timestamp so the window is still output-ish.
			record.startedAt =
				messageTimestamp(finalMessage) || record.completedAt - 500;
		}
		const durationSec = Math.max(
			(record.completedAt - record.startedAt) / 1000,
			0.05,
		);
		// decodeMs is the measured output-only window ONLY when live hooks saw
		// both bounds; scan-reconstructed windows stay 0 → excluded from AVG.
		if (record.sawFirstDelta && record.startedAt > 0) {
			const ms = Math.max(1, record.completedAt - record.startedAt);
			// Guard: a hook-measured window should never be absurdly long —
			// keep an over-flow safety cap far above any real generation.
			record.decodeMs = Math.min(ms, 3600_000);
		}
		record.tps = record.tokens > 0 ? record.tokens / durationSec : 0;
		this.totalOutput += record.tokens;
		this.pendingChars.delete(messageIndex);
		this.steps += 1;
	}

	// ── Tool timing (harness session-stats: call → result pairs) ────────────

	onToolCallStart(callId: string): void {
		if (callId && !this.pendingTools.has(callId)) this.pendingTools.set(callId, Date.now());
	}

	onToolCallEnd(callId: string): void {
		const started = this.pendingTools.get(callId);
		if (started === undefined) return;
		this.pendingTools.delete(callId);
		this.toolMs += Math.max(0, Date.now() - started);
	}

	/**
	 * Branch-derived tool-time fallback for restart-proof stats: pairs each
	 * assistant tool_use call with its toolResult timestamp (matched by
	 * callId) from the session branch. Monotonic — the live-hook sum always
	 * wins because it measures wall clock, while timestamps under-measure by
	 * excluding queueing… but after a restart hooks have nothing, so seeds.
	 */
	syncToolMs(toolMs: number): void {
		if (toolMs > this.toolMs) this.toolMs = toolMs;
	}

	/** Close the currently open turn, accumulating its wall time. */
	onTurnEnd(): void {
		if (this.turnStartAt > 0) {
			this.llmMs += Math.max(0, Date.now() - this.turnStartAt);
			this.turnStartAt = 0;
		}
	}

	// ── Branch-derived session stats (scan fallback) ─────────────────────

	/**
	 * Derive turns / steps from the session branch. Used by the 1s scan so
	 * the strip works even when turn hooks are unavailable (extensions loaded
	 * late, steering/queued flows bypassing them, or providers whose streams
	 * never surface them to us).
	 *
	 * A turn = one user message; a step = one completed assistant message.
	 * Monotonic: values never decrease across scans (branch grows).
	 */
	syncBranchStats(userCount: number, assistantCount: number): void {
		if (userCount > this.turns) this.turns = userCount;
		if (assistantCount > this.steps) this.steps = assistantCount;
	}

	/**
	 * Wall-time fallback from persisted timestamps when hook-based llmMs is
	 * empty: first assistant timestamp → last assistant timestamp on branch.
	 */
	syncWallMs(wallMs: number): void {
		if (wallMs > this.llmMs) this.llmMs = wallMs;
	}

	/**
	 * TTFT fallback for environments where turn hooks never fire (streaming
	 * deltas absent too — e.g. scan-only reconciliation): use the PREVIOUS
	 * assistant message's timestamp as the request bound and the message's own
	 * timestamp as first-output. Approximation; only sampled when no hook
	 * samples exist yet (hook data always wins).
	 */
	seedTtftFallback(previousAssistantTs: number, assistantTs: number, index: number): void {
		if (this.ttftHookSamples > 0) return; // hooks produced real samples
		const record = this.records[index];
		if (!record || record.completedAt === 0 || record.requestAt > 0) return;
		// One seed per record — the scan repeats every second.
		const flagged = record as unknown as { ttftSeeded?: boolean };
		if (flagged.ttftSeeded) return;
		if (previousAssistantTs <= 0 || assistantTs <= previousAssistantTs) return;
		flagged.ttftSeeded = true;
		// Approximate window: prev assistant ts → this assistant ts, clamped so
		// idle gaps can't poison the average.
		this.ttftMs += Math.min(assistantTs - previousAssistantTs, 30_000);
		this.ttftSteps += 1;
	}

	// ── Reconciliation-scan API ───────────────────────────────────────────

	/**
	 * Snapshot update from the 1s branch scan or message_update events.
	 *
	 * For in-flight messages this supplies an optional full-message density
	 * estimate (self-correction). For records already complete it is a no-op.
	 * Timing authority remains the streaming hooks; the scan may only set
	 * startedAt for never-seen messages via onMessageEnd's fallback logic.
	 */
	onMessageUpdate(messageIndex: number, message: unknown, hasStopReason: boolean): void {
		const now = Date.now();
		const existing = this.records[messageIndex];

		if (!existing) {
			// First sighting by the scan. Create the record; do not fabricate
			// start times here — wait for end-of-stream info.
			while (this.records.length < messageIndex) {
				this.records.push({
					messageIndex: this.records.length,
					tokens: 0,
					estimatedTokens: 0,
					anchored: false,
					requestAt: this.lastTurnStart,
					startedAt: 0,
					sawFirstDelta: false,
					completedAt: 0,
			decodeMs: 0,
					tps: 0,
				});
			}
			if (hasStopReason) {
				// Scan-only fast path: already done when first seen.
				this.onMessageStart(messageIndex);
				this.onMessageEnd(messageIndex, message);
			} else {
				this.onMessageStart(messageIndex);
			}
			return;
		}

		if (existing.completedAt !== 0) return; // immutable once done

		// In-flight snapshot: refine the density estimate (max-wins vs deltas).
		const est = estimateOutputTokens(message);
		if (est > existing.estimatedTokens) {
			existing.estimatedTokens = est;
			existing.tokens = est;
		}

		if (hasStopReason) this.onMessageEnd(messageIndex, message);
		else void now; // now unused unless we later need it here
	}

	// ── Metrics ───────────────────────────────────────────────────────────

	/** Live TPS from the currently generating message (output-only window). */
	getLiveTps(): number {
		for (let i = this.records.length - 1; i >= 0; i--) {
			const r = this.records[i];
			if (r.completedAt === 0 && r.startedAt > 0) {
				const elapsedSec = (Date.now() - r.startedAt) / 1000;
				if (elapsedSec <= 0) return 0;
				return r.tokens / elapsedSec;
			}
		}
		// Idle: last completed message
		if (this.records.length > 0) return this.records[this.records.length - 1].tps;
		return 0;
	}

	/** Session average TPS across completed + current generation windows.
	 *
	 * Deepseek-harness contract (projection.ts): throughput =
	 * Σ decodeTokens ÷ Σ decodeMs, sampled ONLY over steps whose decode
	 * window was actually measured (first delta → stream end by live hooks).
	 * Steps without a measured window drop out of the average entirely.
	 *
	 * Scan-reconciled OLD messages (after restart/reload) previously entered
	 * this average with fabricated durations: startedAt from the provider
	 * timestamp, completedAt from 'when our scanner first saw it' (minutes
	 * late), or worse a 'next-entry-ts' window that silently includes tool
	 * runs and user think-time. That made a 100 tok/s model read ~7 tok/s.
	 * We now honor the same rule as the harness: unmeasurable steps are
	 * EXCLUDED, never averaged in with invented durations.
	 */
	getSessionAvgTps(): number {
		let totalTokens = 0;
		let totalDurationSec = 0;
		for (const r of this.records) {
			if (r.completedAt > 0 && r.startedAt > 0 && r.decodeMs > 0) {
				// Measured output-only window (live streaming hooks).
				totalTokens += r.tokens;
				totalDurationSec += r.decodeMs / 1000;
			} else if (r.completedAt === 0 && r.startedAt > 0) {
				// Open generation window: contribute what's elapsed so far.
				totalTokens += r.tokens;
				totalDurationSec += Math.max(0.05, (Date.now() - r.startedAt) / 1000);
			}
		}
		if (totalDurationSec <= 0) return 0;
		return totalTokens / totalDurationSec;
	}

	isStreaming(): boolean {
		for (let i = this.records.length - 1; i >= 0; i--) {
			const r = this.records[i];
			if (r.completedAt === 0 && r.startedAt > 0) return true;
			if (r.completedAt > 0) return false;
		}
		return false;
	}

	/** Total output tokens for the session (anchored per message). */
	getTotalOutput(): number {
		let total = this.totalOutput;
		for (const r of this.records) {
			if (r.completedAt === 0 && r.startedAt > 0) total += r.tokens;
		}
		return total;
	}

	/**
	 * Average time-to-first-token in ms (harness semantics: per-step samples
	 * summed over completed messages where BOTH turn-start and first-delta
	 * were observed; unbounded steps drop out instead of skewing).
	 * Returns null when no complete sample exists.
	 */
	getAvgTtftMs(): number | null {
		return this.ttftSteps > 0 ? Math.round(this.ttftMs / this.ttftSteps) : null;
	}

	/** Number of TTFT samples recorded (diagnostics). */
	getTtftSamples(): number {
		return this.ttftSteps;
	}

	// ── Session strip stats accessors ─────────────────────────────────────

	getTurnCount(): number {
		return this.turns;
	}

	getStepCount(): number {
		return this.steps;
	}

	/** Accumulated agent wall time across completed + open turn, ms. */
	getSessionLlmMs(): number {
		let ms = this.llmMs;
		if (this.turnStartAt > 0) ms += Math.max(0, Date.now() - this.turnStartAt);
		return ms;
	}

	/** Accumulated tool-execution wall time, ms. */
	getToolMs(): number {
		return this.toolMs;
	}

	reset(): void {
		this.records = [];
		this.totalOutput = 0;
		this.pendingChars.clear();
		this.ttftMs = 0;
		this.ttftSteps = 0;
		this.ttftHookSamples = 0;
		this.turns = 0;
		this.steps = 0;
		this.turnStartAt = 0;
		this.llmMs = 0;
		this.pendingTools.clear();
		this.toolMs = 0;
		this.lastTurnStart = 0;
	}
}

/** Singleton TPS tracker instance */
export const tpsTracker = new TpsTracker();
