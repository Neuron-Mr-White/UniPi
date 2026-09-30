/**
 * @pi-unipi/kanboard — the session budget and the write gate.
 *
 * Bash calls into `unipi-kanboard` are split into always-allowed reads and
 * writes. A `/unipi:kanboard-do` grants task SLOTS (each `start` uses one)
 * and a WRITE budget (add, edit, link, order, move backlog↔todo, note on
 * tasks you don't hold). Always free: reads, and `finish`, `move <ID>
 * blocked`, `note <ID>` and `attach <ID>` on claims this session started — a started task
 * can always be closed. Autowork lifts both budgets (the runaway guard is
 * the per-turn add cap). In child processes every write is refused: the
 * lead updates the board.
 */

import { isChildProcess } from "@pi-unipi/core";

import { tokenizeArgs } from "./commands.js";

export interface Budget {
	slots: number;
	writes: number;
	autowork: boolean;
}

export const CHILD_WRITE_REFUSAL =
	"board writes are the lead's job — report this to the lead; the lead updates the board";
export const REMOVED_REFUSAL = "removed: the session works tasks itself (no runner/queue/strategy)";
export const SLOTS_USED_UP =
	"no task slots left — tell the user you can't start more now: raise kanboard.doTasks or run /unipi:kanboard-do again for the next batch";
export const WRITES_USED_UP =
	"kanboard write budget used up — run /unipi:kanboard-do to reload (reads, finish, and blocked/note on your own claims are always free)";
export const addCapReason = (limit: number): string => `at most ${limit} new tasks per turn`;
/** @deprecated tests should read the limit through the guard's getter instead. */
export const ADD_CAP = 20;
export const ADD_CAP_REASON = addCapReason(ADD_CAP);
export const DEFAULT_DO_TASKS = 5;
export const DEFAULT_DO_WRITES = 10;

/** Subcommands that never write to the board. */
const READONLY = new Set(["list", "show", "attachments", "next", "chain", "search", "status"]);

/** Subcommands removed with the runner: refused outright. */
const REMOVED = new Set(["queue", "unqueue", "claim-next", "set-run"]);

/** Global flags that take a value; `--json` is the only valueless one. */
const GLOBAL_VALUE_FLAGS = new Set(["--actor", "--project", "--gate", "--session"]);

/** Quoted spans (single or double quotes), masked before splitting segments. */
const QUOTED_SPAN = /(["'])(?:\\.|(?!\1).)*\1/g;

/**
 * Split a command line into shell segments on `&&`, `||`, `;`, `|` and
 * newlines — ignoring separators inside quoted spans (the mask keeps the
 * original length, so the cut positions map back onto the input exactly).
 */
export function shellSegments(command: string): string[] {
	const masked = command.replace(QUOTED_SPAN, (span) => " ".repeat(span.length));
	const out: string[] = [];
	let at = 0;
	for (const match of masked.matchAll(/&&|\|\||[;|\n]/g)) {
		out.push(command.slice(at, match.index));
		at = match.index + match[0].length;
	}
	out.push(command.slice(at));
	return out;
}

/** `VAR=value` prefixes that may sit in front of the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Wrappers that keep the wrapped word in command position. */
const COMMAND_PREFIXES = new Set(["exec", "command", "env"]);

/**
 * Every subcommand the CLI understands (crates/kanboard/src/cli.rs `Command`,
 * kebab-case as clap spells it). Anything else — a typo like `done`, a bare
 * binary with no subcommand — is the binary's own usage error; the guard
 * neither charges nor blocks it.
 */
export const KNOWN_SUBCOMMANDS = new Set([
	"project", "add", "list", "show", "move", "note", "attach", "attachments",
	"edit", "link", "unlink", "order", "claim-next", "start", "finish", "next",
	"reap", "queue", "unqueue", "chain", "search", "release", "set-run",
	"duplicate", "archive-sweep", "serve", "settings", "rotate-token", "status",
	"stop", "validate",
]);

export interface KanboardInvocation {
	/** First positional after the binary name ("" when absent). */
	sub: string;
	/** Everything after the subcommand. */
	args: string[];
}

/**
 * Every `unipi-kanboard` invocation inside a shell command line. A token
 * counts only when it is positioned like a command: the first word of its
 * segment (segments split on `&&`/`||`/`;`/`|`/newlines, quotes masked),
 * past leading `VAR=value` assignments and the `exec`/`command`/`env`
 * wrappers. `which unipi-kanboard` or `find -name "unipi-kanboard"` merely
 * mention the binary and are not invocations.
 */
export function kanboardInvocations(command: string): KanboardInvocation[] {
	const out: KanboardInvocation[] = [];
	for (const segment of shellSegments(command)) {
		const tokens = tokenizeArgs(segment);
		let head = 0;
		while (head < tokens.length && (ASSIGNMENT.test(tokens[head]!) || COMMAND_PREFIXES.has(tokens[head]!))) {
			head += 1;
		}
		// The binary may be a bare name or an absolute path (and .exe on Windows).
		if (head >= tokens.length || !/unipi-kanboard(\.exe)?$/.test(tokens[head]!)) continue;
		const rest = tokens.slice(head + 1);
		let cursor = 0;
		while (cursor < rest.length) {
			const arg = rest[cursor]!;
			if (arg === "--json") {
				cursor += 1;
				continue;
			}
			if (GLOBAL_VALUE_FLAGS.has(arg)) {
				cursor += 2;
				continue;
			}
			if ([...GLOBAL_VALUE_FLAGS].some((flag) => arg.startsWith(`${flag}=`))) {
				cursor += 1;
				continue;
			}
			break;
		}
		out.push({ sub: rest[cursor] ?? "", args: rest.slice(cursor + 1) });
	}
	return out;
}

/** Read-only means: no writes, and the board does not change. */
export function isReadonly(invocation: KanboardInvocation): boolean {
	if (READONLY.has(invocation.sub)) return true;
	if (invocation.sub === "project") {
		return invocation.args[0] === "list" || invocation.args[0] === "show";
	}
	if (invocation.sub === "settings") {
		return invocation.args[0] !== "set"; // bare/`show` reads; `set` writes
	}
	if (invocation.sub === "validate") {
		return !invocation.args.includes("--fix");
	}
	return false;
}

/** First non-flag positional of an invocation (the task id for task commands). */
export function firstPositional(invocation: KanboardInvocation): string | undefined {
	return invocation.args.find((arg) => !arg.startsWith("-"));
}

/** `move <ID> blocked` (the free own-claim close). */
export function isMoveBlocked(invocation: KanboardInvocation): boolean {
	return invocation.sub === "move" && invocation.args.includes("blocked") && firstPositional(invocation) !== undefined;
}

/** `edit --strategy …` / `--plan …` — strategy labels died with the runner. */
export function isRemovedEdit(invocation: KanboardInvocation): boolean {
	return (
		invocation.sub === "edit" &&
		(invocation.args.some((arg) => arg === "--strategy" || arg.startsWith("--strategy=")) ||
			invocation.args.some((arg) => arg === "--plan" || arg.startsWith("--plan=")))
	);
}

export interface WriteGuard {
	/** -do: slots = max(slots, doTasks), writes = max(writes, doWrites); resets the add cap. */
	open(): void;
	/** Autowork on/off: board writes (and starts) become free. */
	setAutowork(on: boolean): void;
	/** -do off: slots = writes = 0. */
	revoke(): void;
	/** Budget left this session. */
	remaining(): Budget;
	/** Arm the agent_end closer right after the -do prompt was sent. */
	noteSent(): void;
	/** The budget persists across turns; this only closes the -do window label. */
	onAgentEnd(): boolean;
	/**
	 * null when the command is allowed; otherwise the block reason.
	 * `ownsClaim(id)` answers "is this task claimed by this session" (cached
	 * per check call).
	 */
	check(command: string, deps?: { ownsClaim(id: string): Promise<boolean> }): Promise<string | null>;
}

export interface WriteGuardOptions {
	/** `add` calls allowed per turn (0 = unlimited; kanboard.turnAddLimit). */
	addLimit?: () => number;
	/** Task slots a -do grants (kanboard.doTasks). */
	doTasks?: () => number;
	/** Board writes a -do grants (kanboard.doWrites). */
	doWrites?: () => number;
	/** Children cannot write at all; injectable for tests. */
	isChild?: () => boolean;
}

/**
 * Writes cost the session budget; reads, own-claim closes and autowork work
 * are free. Invocations whose subcommand does not exist are skipped: the
 * binary itself rejects them with a usage error, and one typo must not block
 * the rest of a compound call. Budgets persist across turns until spent;
 * /unipi:kanboard-do tops up without stacking past N.
 */
export function createWriteGuard(options: WriteGuardOptions = {}): WriteGuard {
	const addLimit = options.addLimit ?? (() => ADD_CAP);
	const doTasks = options.doTasks ?? (() => DEFAULT_DO_TASKS);
	const doWrites = options.doWrites ?? (() => DEFAULT_DO_WRITES);
	const child = options.isChild ?? isChildProcess;

	let slots = 0;
	let writes = 0;
	let autowork = false;
	let doOpen = false;
	let sentAt = 0;
	let adds = 0;
	const countAdd = (invocation: KanboardInvocation): string | null => {
		if (invocation.sub !== "add") return null;
		adds += 1;
		const limit = addLimit();
		return limit > 0 && adds > limit ? addCapReason(limit) : null;
	};
	return {
		open() {
			slots = Math.max(slots, Math.max(0, doTasks()));
			writes = Math.max(writes, Math.max(0, doWrites()));
			adds = 0;
			doOpen = true;
		},
		setAutowork(on: boolean) {
			autowork = on;
		},
		revoke() {
			slots = 0;
			writes = 0;
			doOpen = false;
		},
		remaining() {
			return { slots, writes, autowork };
		},
		noteSent() {
			sentAt = Date.now();
		},
		onAgentEnd() {
			if (!doOpen) return false;
			if (Date.now() - sentAt < 150) return false; // late end from the previous turn
			doOpen = false;
			return true;
		},
		async check(command, checkDeps) {
			const invocations = kanboardInvocations(command);
			if (invocations.length === 0) return null;
			const childProcess = child();
			const claimCache = new Map<string, boolean>();
			const ownsClaim = async (id: string): Promise<boolean> => {
				if (!checkDeps?.ownsClaim) return false;
				const cached = claimCache.get(id);
				if (cached !== undefined) return cached;
				let owned = false;
				try {
					owned = await checkDeps.ownsClaim(id);
				} catch {
					owned = false; // an ownership probe failure never grants a free write
				}
				claimCache.set(id, owned);
				return owned;
			};
			for (const invocation of invocations) {
				// An unknown subcommand (a typo, a bare binary) is the binary's own
				// usage error — never a reason to block or charge the whole call.
				if (!KNOWN_SUBCOMMANDS.has(invocation.sub)) continue;
				if (isReadonly(invocation)) continue;
				if (childProcess) return CHILD_WRITE_REFUSAL;
				if (REMOVED.has(invocation.sub) || isRemovedEdit(invocation)) return REMOVED_REFUSAL;
				// The add cap applies always (runaway guard), before any charging.
				const cap = countAdd(invocation);
				if (cap) return cap;
				if (invocation.sub === "finish") continue; // always free
				if (invocation.sub === "move" && isMoveBlocked(invocation)) {
					const id = firstPositional(invocation)!;
					if (await ownsClaim(id)) continue; // closing your own claim is free
				}
				if ((invocation.sub === "note" || invocation.sub === "attach") && firstPositional(invocation) !== undefined) {
					const id = firstPositional(invocation)!;
					if (await ownsClaim(id)) continue; // noting on / attaching to your own claim is free
				}
				if (autowork) continue; // autowork: unlimited slots and writes
				if (invocation.sub === "start") {
					if (slots <= 0) return SLOTS_USED_UP;
					slots -= 1;
					continue;
				}
				if (writes <= 0) return WRITES_USED_UP;
				writes -= 1;
			}
			return null;
		},
	};
}
