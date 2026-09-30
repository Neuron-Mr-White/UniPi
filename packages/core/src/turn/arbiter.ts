/**
 * Turn arbiter — the single `agent_before_settle` decision point.
 *
 * Nudge providers (long-horizon owner, kanboard monitor, …) propose at most
 * one continuation each; wait sources (bg wake, busy sidekick, background
 * subagent) veto; the handler delivers at most ONE custom_message nudge per
 * settle and continues the run exactly once.
 *
 * Composition semantics (pi 0.99, verified live, docs/plans/2026-09-30-01a0f095.md
 * Step 0): boundary handlers run in registration order, each awaited; a handler
 * result's `entries` REPLACES the accumulated array (so the handler must concat
 * `event.entries` itself) and `continue` is OR-ed. Events queued as followUps
 * are drained before the boundary, so `pendingMessages` is a defence-only
 * check; a run aborted with Esc never reaches the boundary at all.
 *
 * State lives in a `Symbol.for` global so every package that imports core
 * shares one arbiter, and the installer is idempotent across reloads.
 */

import type { AgentBeforeSettleEventResult, CustomMessageEntryDraft, ExtensionAPI, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

export interface SettleInfo {
	outcome: "completed" | "aborted" | "error";
	pendingMessages: number;
	/** Text parts of the last assistant message, joined. */
	lastAssistantText: string;
	/** Whether the last assistant message carried tool-call parts. */
	lastAssistantHadToolCalls: boolean;
	/** Tool calls since the last `agent_start` (counted by the installer). */
	toolCallsThisRun: number;
}

export interface Nudge {
	source: string;
	priority: number;
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
	/** Called once, only when THIS nudge is the one delivered. */
	onDelivered?: () => void;
}

export type SettleDecision =
	| { kind: "nudge"; source: string; priority: number }
	| { kind: "none"; reason: "outcome" | "pending" | "continuing" | "wait" | "no-proposal"; detail?: string };

export type NudgeProvider = {
	source: string;
	priority: number;
	propose: (s: SettleInfo) => Nudge | null | Promise<Nudge | null>;
};

export type WaitSource = { source: string; waiting: () => string | null };

export type SettleDecisionListener = (decision: SettleDecision, info: SettleInfo) => void;

interface ArbiterHolder {
	/** Keyed by source: re-registering a source replaces it (reload-safe) and keeps its original order. */
	providers: Map<string, NudgeProvider>;
	waitSources: Map<string, WaitSource>;
	listeners: Set<SettleDecisionListener>;
	installed: boolean;
	toolCallsThisRun: number;
	providerTimeoutMs: number;
}

const KEY = Symbol.for("unipi.turn.arbiter");
const DEFAULT_PROVIDER_TIMEOUT_MS = 2_000;

function holder(): ArbiterHolder {
	const g = globalThis as { [KEY]?: ArbiterHolder };
	g[KEY] ??= {
		providers: new Map(),
		waitSources: new Map(),
		listeners: new Set(),
		installed: false,
		toolCallsThisRun: 0,
		providerTimeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS,
	};
	return g[KEY] as ArbiterHolder;
}

/** Children are the hands, the lead is the voice: no arbiter, no nudges. */
export function isChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.UNIPI_FUSION_CHILD === "1" || env.UNIPI_SUBAGENT_CHILD === "1" || Boolean(env.UNIPI_KANBOARD_CHILD);
}

export function registerNudgeProvider(
	source: string,
	priority: number,
	propose: (s: SettleInfo) => Nudge | null | Promise<Nudge | null>,
): () => void {
	const h = holder();
	h.providers.set(source, { source, priority, propose });
	return () => {
		const current = h.providers.get(source);
		if (current?.propose === propose) h.providers.delete(source);
	};
}

export function registerWaitSource(source: string, waiting: () => string | null): () => void {
	const h = holder();
	h.waitSources.set(source, { source, waiting });
	return () => {
		const current = h.waitSources.get(source);
		if (current?.waiting === waiting) h.waitSources.delete(source);
	};
}

export function onSettleDecision(listener: SettleDecisionListener): () => void {
	const h = holder();
	h.listeners.add(listener);
	return () => {
		h.listeners.delete(listener);
	};
}

async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Pure decision core of the settle handler (no pi types), exported for tests.
 * Order matters: outcome → pending (defence only, see Step 0) → already
 * continuing → wait sources → highest-priority proposal (tie: earliest
 * registered). Provider throw/timeout counts as no proposal.
 */
export async function decideSettle(
	info: SettleInfo,
	alreadyContinuing: boolean,
): Promise<{ decision: SettleDecision; nudge?: Nudge }> {
	const h = holder();
	if (info.outcome !== "completed") {
		return { decision: { kind: "none", reason: "outcome", detail: info.outcome } };
	}
	if (info.pendingMessages > 0) {
		return { decision: { kind: "none", reason: "pending" } };
	}
	if (alreadyContinuing) {
		return { decision: { kind: "none", reason: "continuing" } };
	}
	for (const waitSource of h.waitSources.values()) {
		let reason: string | null = null;
		try {
			reason = waitSource.waiting();
		} catch {
			reason = null; // a broken wait source never blocks settlement
		}
		if (reason !== null) {
			return { decision: { kind: "none", reason: "wait", detail: `${waitSource.source}: ${reason}` } };
		}
	}
	let best: { nudge: Nudge } | undefined;
	for (const provider of h.providers.values()) {
		let nudge: Nudge | null | undefined;
		try {
			nudge = await raceTimeout(Promise.resolve(provider.propose(info)), h.providerTimeoutMs);
		} catch {
			nudge = null;
		}
		if (nudge === null || nudge === undefined) continue;
		if (best === undefined || nudge.priority > best.nudge.priority) best = { nudge };
	}
	if (best === undefined) return { decision: { kind: "none", reason: "no-proposal" } };
	return {
		decision: { kind: "nudge", source: best.nudge.source, priority: best.nudge.priority },
		nudge: best.nudge,
	};
}

const TOOL_CALL_PART_TYPES = new Set(["toolCall", "tool_call", "toolUse", "tool_use"]);

interface AssistantSummary {
	text: string;
	hadToolCalls: boolean;
}

function summarizeAssistant(messages: readonly unknown[]): AssistantSummary {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null) continue;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") continue;
		const content = record.content;
		if (typeof content === "string") return { text: content, hadToolCalls: false };
		if (!Array.isArray(content)) return { text: "", hadToolCalls: false };
		let text = "";
		let hadToolCalls = false;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const block = part as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") text += block.text;
			else if (block.type !== undefined && TOOL_CALL_PART_TYPES.has(String(block.type))) hadToolCalls = true;
		}
		return { text, hadToolCalls };
	}
	return { text: "", hadToolCalls: false };
}

/**
 * Install the single `agent_before_settle` handler. Idempotent: the first
 * call wins (holder flag) — later calls, including from long-horizon's
 * standalone factory, are no-ops. In child processes it registers nothing.
 */
export function installArbiter(pi: ExtensionAPI): void {
	const h = holder();
	if (h.installed) return;
	h.installed = true;
	if (isChildProcess()) return;

	pi.on("agent_start", () => {
		try {
			h.toolCallsThisRun = 0;
		} catch {
			// Accounting must never abort a turn.
		}
	});
	pi.on("tool_call", () => {
		try {
			h.toolCallsThisRun += 1;
		} catch {
			// Accounting must never abort a turn.
		}
	});
	pi.on("agent_before_settle", async (event): Promise<AgentBeforeSettleEventResult | undefined> => {
		try {
			const settleEvent = event as {
				outcome?: SettleInfo["outcome"];
				continue?: boolean;
				entries?: SessionBoundaryDraft[];
				context?: { pendingMessages?: unknown[]; contextMessages?: unknown[] };
			};
			const assistant = summarizeAssistant(settleEvent.context?.contextMessages ?? []);
			const info: SettleInfo = {
				outcome: settleEvent.outcome ?? "completed",
				pendingMessages: settleEvent.context?.pendingMessages?.length ?? 0,
				lastAssistantText: assistant.text,
				lastAssistantHadToolCalls: assistant.hadToolCalls,
				toolCallsThisRun: h.toolCallsThisRun,
			};
			const { decision, nudge } = await decideSettle(info, settleEvent.continue === true);
			for (const listener of h.listeners) {
				try {
					listener(decision, info);
				} catch {
					// A broken listener must never break settlement.
				}
			}
			if (decision.kind !== "nudge" || nudge === undefined) return undefined;
			try {
				nudge.onDelivered?.();
			} catch {
				// Delivery bookkeeping must never abort a turn.
			}
			const entry: CustomMessageEntryDraft = {
				type: "custom_message",
				customType: nudge.customType,
				content: nudge.content,
				display: nudge.display,
				...(nudge.details !== undefined ? { details: nudge.details } : {}),
			};
			// Boundary `entries` are REPLACED by the last handler that returns
			// them — always carry the accumulated array forward.
			return { entries: [...(settleEvent.entries ?? []), entry], continue: true };
		} catch {
			// The arbiter must never abort a turn.
			return undefined;
		}
	});
}

/** Test hook: clear every registration and the installed flag. */
export function resetArbiterForTests(opts?: { providerTimeoutMs?: number }): void {
	const h = holder();
	h.providers.clear();
	h.waitSources.clear();
	h.listeners.clear();
	h.installed = false;
	h.toolCallsThisRun = 0;
	h.providerTimeoutMs = opts?.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
}
