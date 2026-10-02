/**
 * One-slot nudge stash — the long-horizon handoff between `agent_end`
 * settlement and the arbiter's `agent_before_settle` boundary.
 *
 * Continuation/ralph "sends" land here instead of pi's message queue; the
 * package's nudge provider (priority 100) returns the stash at the boundary
 * and takes it on delivery. A put overwrites an undelivered nudge (the newest
 * intent wins) EXCEPT when the undelivered stash is a kickoff: the kickoff
 * contract must never be lost, so a new put appends with a blank line and the
 * merged stash stays kickoff-flagged until delivered.
 */

export interface NudgeStashPutOptions {
	/** Marks the kickoff contract (append-only while undelivered). */
	kickoff?: boolean;
}

export class NudgeStash {
	private text: string | null = null;
	private kickoff = false;

	put(text: string, options: NudgeStashPutOptions = {}): void {
		if (this.text !== null && this.kickoff) {
			this.text = `${this.text}\n\n${text}`;
			return;
		}
		this.text = text;
		this.kickoff = options.kickoff ?? false;
	}

	/** Undelivered text, or null. */
	peek(): string | null {
		return this.text;
	}

	/** Take the text out (delivered). */
	take(): string | null {
		const text = this.text;
		this.text = null;
		this.kickoff = false;
		return text;
	}
}

/**
 * Owner lifecycle events that invalidate an undelivered nudge: when the owner
 * stops or parks, a queued hint targets a machine that no longer drives. The
 * wrap-up survives because continuation puts it AFTER owner.finish commits.
 */
export interface StashMetaState<M> {
	meta: M | undefined;
	kickoff: boolean;
}

/** Pure metadata mirror of the stash merge semantics: a put into an undelivered
 * KICKOFF appends and KEEPS the original provenance; any other put replaces it.
 * `hasText` mirrors stash.peek() !== null. */
export function nextStashMetaState<M>(
	prev: StashMetaState<M> | undefined,
	hasText: boolean,
	kind: "kickoff" | undefined,
	incoming: M,
): StashMetaState<M> {
	const merging = hasText && (prev?.kickoff ?? false);
	if (merging) return { meta: prev?.meta, kickoff: true };
	return { meta: incoming, kickoff: kind === "kickoff" };
}

export function ownerEventClearsStash(event: { type: string }): boolean {
	return event.type === "finished" || event.type === "suspended";
}
