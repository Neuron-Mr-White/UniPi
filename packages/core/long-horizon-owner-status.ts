/**
 * @pi-unipi/core — shared long-horizon owner status
 *
 * The long-horizon package owns the automation owner lifecycle; kanboard's
 * monitor (step 4) needs to defer to an active owner and to notice one that
 * STOPPED this run ("goal paused — UNI-30 left In Progress"). Same
 * Symbol.for global pattern as long-horizon-status: published on every owner
 * transition, pulled by readers whenever they settle.
 */

export interface SharedOwnerStatus {
	/** Current owner, when one exists (active, or parked in the single slot). */
	owner?: { kind: string; status: "active" | "parked" };
	/** Last owner stop. Kanboard compares `at` against its turn-start marker. */
	lastStop?: { kind: "complete" | "paused" | "budget" | "other"; at: number };
}

const KEY = Symbol.for("unipi.longHorizon.ownerStatus");

type Holder = { status?: SharedOwnerStatus | undefined };

function holder(): Holder {
	const g = globalThis as { [KEY]?: Holder };
	g[KEY] ??= {};
	return g[KEY] as Holder;
}

/** Publish the current owner (undefined clears it — no owner active or parked). */
export function setSharedOwner(owner: SharedOwnerStatus["owner"]): void {
	const h = holder();
	h.status ??= {};
	if (owner === undefined) delete h.status.owner;
	else h.status.owner = owner;
}

/** Record that an owner stopped, with the mapped terminal kind. */
export function markSharedOwnerStopped(kind: "complete" | "paused" | "budget" | "other"): void {
	const h = holder();
	h.status ??= {};
	h.status.lastStop = { kind, at: Date.now() };
}

/** Read the published status, or undefined before the first transition. */
export function getSharedOwnerStatus(): SharedOwnerStatus | undefined {
	return holder().status;
}
