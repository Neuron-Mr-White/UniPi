/**
 * Pending-work monitor (UNI-162 "end judgement: pi/herdr/unipi say
 * idle/ended while subagents, wake-up bg tasks or sidekick handoffs are
 * still pending").
 *
 * Before: the turn arbiter's wait sources (bg wake, subagents, fusion
 * handoffs) ONLY vetoed arbiter nudges at `agent_before_settle` — nothing
 * else read them, so herdr, notify's "done" notifications and the app
 * bridge's idle "needs you" mark all treated a settled turn as genuinely
 * idle even while one of those sources still had a reason (a background
 * subagent running, a bg task that will wake the agent, a non-blocking
 * sidekick handoff in flight).
 *
 * After: one process-wide monitor claims herdr `working` under a single key
 * ("pending-work") for as long as ANY wait source has a reason, re-checking
 * on the shared work-list change signal (falls back to its own 1 s poll —
 * reusing the arbiter's wait sources needs no extra wiring). `agent_start`
 * clears the claim immediately (a fresh turn is not "ended"). This REPLACES
 * the per-package herdr claims each wait-source owner used to make
 * individually (background-tasks' "bg-wake", fusion's "fusion-sidekick") —
 * see their call sites, now routed through this single claim instead.
 *
 * Install is idempotent (first call wins), same pattern as the arbiter.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentWaitReasons, isChildProcess } from "./arbiter.js";
import { setHerdrWorking } from "../../utils.js";
import { subscribeWorkChanges } from "../work/index.js";

export const PENDING_WORK_KEY = "pending-work";

const KEY = Symbol.for("unipi.turn.pending-work-monitor");

interface MonitorHolder {
	installed: boolean;
	unsubWork: (() => void) | undefined;
	pollTimer: ReturnType<typeof setInterval> | undefined;
	lastLabel: string | null;
}

function holder(): MonitorHolder {
	const g = globalThis as { [KEY]?: MonitorHolder };
	g[KEY] ??= { installed: false, unsubWork: undefined, pollTimer: undefined, lastLabel: null };
	return g[KEY] as MonitorHolder;
}

/**
 * Build the pending-work label from the current wait-source reasons, or
 * null when nothing is pending. Exported for tests (pure, no herdr/pi side
 * effects).
 */
export function pendingWorkLabel(reasons: ReadonlyArray<{ source: string; reason: string }> = currentWaitReasons()): string | null {
	if (reasons.length === 0) return null;
	return reasons.map((r) => r.reason).join(" · ");
}

/** True while any wait source currently has a reason. */
export function hasPendingWork(): boolean {
	return currentWaitReasons().length > 0;
}

function reevaluate(pi: ExtensionAPI): void {
	try {
		const label = pendingWorkLabel();
		setHerdrWorking(pi, PENDING_WORK_KEY, label);
		holder().lastLabel = label;
	} catch {
		// Claiming herdr state must never throw out of a poll/change tick.
	}
}

/**
 * Install the pending-work monitor. Idempotent: the first call wins. In
 * child processes it installs nothing (children never own a claim — same
 * contract as the arbiter and the per-package wait-source registrations).
 */
export function installPendingWorkMonitor(pi: ExtensionAPI): void {
	const h = holder();
	if (h.installed) return;
	h.installed = true;
	if (isChildProcess()) return;

	pi.on("agent_start", () => {
		// A fresh turn starting is not "ended" — drop any stale claim
		// immediately rather than waiting for the next poll/change tick.
		try {
			setHerdrWorking(pi, PENDING_WORK_KEY, null);
			h.lastLabel = null;
		} catch {
			// Must never abort agent_start.
		}
	});

	pi.on("agent_settled", () => {
		reevaluate(pi);
	});

	// Re-check on the shared work-list change signal (bg registry / subagents
	// / fusion status), with a 1 s fallback poll while subscribed — same
	// budget contract as subscribeWorkChanges itself.
	h.unsubWork = subscribeWorkChanges(() => reevaluate(pi));
	h.pollTimer = setInterval(() => reevaluate(pi), 1000);
	h.pollTimer.unref?.();
}

/** Test hook: clear every registration and the installed flag. */
export function resetPendingWorkMonitorForTests(): void {
	const h = holder();
	h.unsubWork?.();
	h.unsubWork = undefined;
	if (h.pollTimer) clearInterval(h.pollTimer);
	h.pollTimer = undefined;
	h.installed = false;
	h.lastLabel = null;
}
