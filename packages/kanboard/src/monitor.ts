/**
 * @pi-unipi/kanboard — the turn arbiter's kanboard nudge provider.
 *
 * Replaces the runner and the R2 reminder: when the lead settles with claims
 * of its own still In Progress, the monitor proposes ONE continuation nudge
 * (priority 50, claims; priority 40, autowork-next). The arbiter delivers at
 * most one nudge per settle, so the monitor never fights the long-horizon
 * owner (priority 100) or a pending event. Lead only — children never
 * register it.
 */

import type { Nudge, SettleInfo } from "@pi-unipi/core";
import { kanboardGlanceLabel } from "@pi-unipi/core";

import { ANTI_POISONING_SUFFIX, taskIdsIn } from "./reminders.js";
import type { KanboardTask } from "./shapes.js";

export const CLAIMS_NUDGE_CUSTOM_TYPE = "unipi:kanboard-continue";
export const AUTOWORK_NUDGE_CUSTOM_TYPE = "unipi:kanboard-next";
export const CLAIMS_PRIORITY = 50;
export const AUTOWORK_PRIORITY = 40;
/** Hard cap of continuation nudges per task. */
export const MAX_NUDGES_PER_TASK = 5;
/** Consecutive nudged runs with zero tool calls before the monitor gives up. */
export const STALL_LIMIT = 2;
/** Offers of the SAME ready task before autowork gives up on it. */
export const MAX_OFFERS_PER_TASK = 3;

export interface MonitorDeps {
	/** `list --json` on this session's project (board order). */
	list(): Promise<KanboardTask[]>;
	/** `list --ready --json` (todo tasks whose deps are met), board order. */
	listReady(): Promise<KanboardTask[]>;
	/** This session's id (UNIPI_KANBOARD_SESSION). */
	session(): string;
	/** Shared long-horizon owner status holder. */
	ownerStatus(): { owner?: { kind: string; status: string }; lastStop?: { kind: string; at: number } } | undefined;
	/** Wall clock (injectable in tests). */
	now(): number;
	/** User-only notices (never LLM context) — implementations must only queue. */
	notify(text: string, level?: "info" | "warning"): void;
	/** The monitor itself turned autowork off (done / stalled) — guard + holder follow. */
	onAutoworkOff?(): void;
	/** `<binary> --actor agent --project <slug>` for the nudge text, or null. */
	cliPrefix(): string | null;
	debug?(line: string): void;
}

export interface KanboardMonitor {
	/** agent_start: the run that is about to start; stamps runStartedAt. */
	onAgentStart(): void;
	/** A user prompt: re-arm when it names one of our claimed ids. */
	onUserPrompt(text: string): Promise<void>;
	/** agent_end: an aborted or errored run disarms (kanboard never re-nudges after Esc). */
	onAgentEnd(messages: unknown[] | undefined): void;
	/** Arm the monitor (from -do, autowork start, or a successful lead `start`). */
	arm(reason?: string): void;
	disarm(): void;
	setAutowork(on: boolean): void;
	/** The nudge provider body (throws are caught by the arbiter, not here). */
	propose(info: SettleInfo): Promise<Nudge | null>;
	/** For tests / the status holder. */
	state(): {
		armed: boolean;
		autowork: boolean;
		nudgesPerTask: Record<string, number>;
		noProgressRuns: number;
	};
}

/** Last assistant message aborted or errored (Step 0 Q1d: stopReason). */
function runFailed(messages: unknown[] | undefined): boolean {
	if (!Array.isArray(messages)) return false;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; stopReason?: string };
		if (message?.role === "assistant") return message.stopReason === "aborted" || message.stopReason === "error";
	}
	return false;
}

/** The final non-empty paragraph of a text, trimmed. */
function finalParagraph(text: string): string {
	const paragraphs = text.trim().split(/\n\s*\n/).filter((part) => part.trim().length > 0);
	return (paragraphs.at(-1) ?? "").trim();
}

function ownClaim(task: KanboardTask, session: string): boolean {
	const run = task.run as { session?: string } | null | undefined;
	return task.status === "in_progress" && run?.session === session;
}

/** Our own runtime texts never count as user prompts naming claimed ids. */
function isOwnRuntimeText(text: string): boolean {
	return (
		text.includes(ANTI_POISONING_SUFFIX) ||
		text.includes(CLAIMS_NUDGE_CUSTOM_TYPE) ||
		text.includes(AUTOWORK_NUDGE_CUSTOM_TYPE)
	);
}

export function createKanboardMonitor(deps: MonitorDeps): KanboardMonitor {
	const debug = (line: string): void => deps.debug?.(`monitor: ${line}`);
	let armed = false;
	let autowork = false;
	let runStartedAt = 0;
	let lastRunWasNudge = false;
	let nudgeDelivered = false;
	let noProgressRuns = 0;
	/** Continuation nudges per task id (delivered, not proposed). */
	const nudgesPerTask = new Map<string, number>();
	/** Autowork offers per ready task id (delivered; reset when it leaves ready). */
	const offersPerTask = new Map<string, number>();
	/** Notice dedupe per condition; cleared on re-arm. */
	const notified = new Set<string>();
	const notifyOnce = (key: string, text: string, level: "info" | "warning" = "info"): void => {
		if (notified.has(key)) return;
		notified.add(key);
		deps.notify(text, level);
	};
	const autoworkOff = (why: string): void => {
		autowork = false;
		try {
			deps.onAutoworkOff?.();
		} catch {
			// A broken callback must never break settlement.
		}
		debug(`autowork off (${why})`);
	};
	const disarmNow = (): void => {
		if (armed) debug("disarmed");
		armed = false;
	};

	const claimedFrom = (tasks: KanboardTask[]): KanboardTask[] => {
		const session = deps.session();
		return tasks.filter((task) => ownClaim(task, session));
	};

	return {
		onAgentStart() {
			// The run that just started was nudged iff the previous settle delivered.
			lastRunWasNudge = nudgeDelivered;
			nudgeDelivered = false;
			runStartedAt = deps.now();
		},

		async onUserPrompt(text) {
			if (isOwnRuntimeText(text)) return;
			const named = taskIdsIn(text);
			if (named.length === 0) return;
			try {
				const claimed = claimedFrom(await deps.list()).map((task) => task.id);
				if (named.some((id) => claimed.includes(id))) {
					armed = true;
					notified.clear();
					debug(`re-armed by user prompt naming ${claimed.join(", ")}`);
				}
			} catch (error) {
				debug(`prompt re-arm list failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},

		onAgentEnd(messages) {
			if (runFailed(messages)) {
				// Esc (or a provider error): kanboard never re-nudges over the user.
				disarmNow();
			}
		},

		arm(reason) {
			armed = true;
			notified.clear();
			debug(`armed${reason ? ` (${reason})` : ""}`);
		},

		disarm() {
			disarmNow();
		},

		setAutowork(on) {
			autowork = on;
		},

		async propose(info) {
			if (!armed) return null;
			let tasks: KanboardTask[];
			try {
				tasks = await deps.list();
			} catch (error) {
				debug(`list failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
			const claims = claimedFrom(tasks);

			// A long-horizon owner drives continuation: kanboard stays quiet.
			// An owner that STOPPED this run matters: complete → kanboard takes
			// over again; paused/budget/other → tell the user what was left.
			const owner = deps.ownerStatus();
			if (owner?.owner?.status === "active") return null;
			const stop = owner?.lastStop;
			if (stop && stop.at >= runStartedAt && stop.kind !== "complete") {
				if (claims.length > 0) {
					const ids = claims.map((task) => task.id).join(", ");
					const kindWord = stop.kind === "paused" ? "paused" : stop.kind === "budget" ? "hit its budget" : "stopped";
					notifyOnce(
						`goal-stop:${ids}`,
						`kanboard: goal ${kindWord} — ${ids} left In Progress`,
					);
				}
				disarmNow();
				return null;
			}

			if (claims.length > 0) {
				// Question heuristic: the agent ended by asking the user something —
				// a nudge would talk over the question. Notice only, no count.
				if (!info.lastAssistantHadToolCalls && finalParagraph(info.lastAssistantText).endsWith("?")) {
					const ids = claims.map((task) => task.id).join(", ");
					notifyOnce(`question:${ids}`, `kanboard: ${ids} left In Progress — the agent asked you a question`);
					return null;
				}
				// Stall guard: nudged runs that did nothing.
				if (lastRunWasNudge && info.toolCallsThisRun === 0) noProgressRuns += 1;
				else if (info.toolCallsThisRun > 0) noProgressRuns = 0;
				if (noProgressRuns >= STALL_LIMIT) {
					const ids = claims.map((task) => task.id).join(", ");
					notifyOnce(`stall:${ids}`, `kanboard: ⚠ ${ids} stalled — no progress after ${String(STALL_LIMIT)} nudges`, "warning");
					disarmNow();
					return null;
				}
				const rest = claims.slice(1).map((task) => task.id);
				const target = claims.find((task) => (nudgesPerTask.get(task.id) ?? 0) < MAX_NUDGES_PER_TASK);
				if (!target) {
					const ids = claims.map((task) => task.id).join(", ");
					notifyOnce(`cap:${ids}`, `kanboard: ⚠ ${ids} stalled — nudge cap (${String(MAX_NUDGES_PER_TASK)}) reached`, "warning");
					disarmNow();
					return null;
				}
				const n = (nudgesPerTask.get(target.id) ?? 0) + 1;
				const prefix = deps.cliPrefix() ?? "unipi-kanboard";
				const also = rest.length > 0 ? ` · also open: ${rest.join(", ")}` : "";
				const content =
					`↻ ${target.id} still In Progress — continue, or finish/block it (${String(n)}/${String(MAX_NUDGES_PER_TASK)})${also}\n` +
					`\`${prefix} finish ${target.id} --comment "<summary>"\` / \`${prefix} move ${target.id} blocked --comment "<what you need>"\` ` +
					ANTI_POISONING_SUFFIX;
				return {
					source: "kanboard",
					priority: CLAIMS_PRIORITY,
					customType: CLAIMS_NUDGE_CUSTOM_TYPE,
					content,
					display: true,
					onDelivered: () => {
						nudgesPerTask.set(target.id, n); // counts on DELIVERY, not proposal
						nudgeDelivered = true;
					},
				};
			}

			if (autowork) {
				// The same stall rule as claims: an offered run that did nothing.
				if (lastRunWasNudge && info.toolCallsThisRun === 0) noProgressRuns += 1;
				else if (info.toolCallsThisRun > 0) noProgressRuns = 0;
				if (noProgressRuns >= STALL_LIMIT) {
					notifyOnce(
						"autowork-stall",
						`kanboard: ⚠ autowork stalled — no progress after ${String(STALL_LIMIT)} offers`,
						"warning",
					);
					autoworkOff("stalled");
					disarmNow();
					return null;
				}
				let ready: KanboardTask[];
				try {
					ready = (await deps.listReady()).filter((task) => task.status === "todo");
				} catch (error) {
					debug(`listReady failed: ${error instanceof Error ? error.message : String(error)}`);
					return null;
				}
				const next = ready[0];
				if (next) {
					// A task that left the ready list gets a fresh offer budget.
					for (const id of [...offersPerTask.keys()]) {
						if (!ready.some((task) => task.id === id)) offersPerTask.delete(id);
					}
					const offers = (offersPerTask.get(next.id) ?? 0) + 1;
					if (offers > MAX_OFFERS_PER_TASK) {
						notifyOnce(`autowork-cap:${next.id}`, `kanboard: ⚠ autowork stalled on ${next.id}`, "warning");
						autoworkOff(`cap:${next.id}`);
						disarmNow();
						return null;
					}
					return {
						source: "kanboard",
						priority: AUTOWORK_PRIORITY,
						customType: AUTOWORK_NUDGE_CUSTOM_TYPE,
						content: `↻ next ready: ${next.id} ${next.displayTitle || next.title || "(untitled)"} — show it, start it, work it (autowork) ${ANTI_POISONING_SUFFIX}`,
						display: true,
						onDelivered: () => {
							offersPerTask.set(next.id, offers); // counts on DELIVERY, not proposal
							nudgeDelivered = true;
						},
					};
				}
				const inReview = tasks.filter((task) => task.status === "in_review").length;
				const blocked = tasks.filter((task) => task.status === "blocked").length;
				notifyOnce("autowork-done", `kanboard: autowork done · ${String(inReview)} in review · ${String(blocked)} blocked`);
				autoworkOff("done");
				disarmNow();
				return null;
			}

			return null;
		},

		state() {
			return {
				armed,
				autowork,
				nudgesPerTask: Object.fromEntries(nudgesPerTask),
				noProgressRuns,
			};
		},
	};
}

/** Glance label for the current claims/autowork snapshot (re-exported read). */
export const monitorGlanceLabel = kanboardGlanceLabel;
