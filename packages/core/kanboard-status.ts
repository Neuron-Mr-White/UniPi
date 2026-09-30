/**
 * @pi-unipi/core — shared kanboard status
 *
 * The kanboard package owns the session's board claims and autowork flag;
 * the footer package owns the glance title segment that should display them
 * (`▣ UNI-30`, `▣ UNI-30 +1`, `▣ autowork`). Same Symbol.for global pattern
 * as fusion-status: published by kanboard after board changes and at each
 * settle, pulled by the footer every render.
 */

export interface SharedKanboardStatus {
	/** Ids this session holds In Progress (board order). */
	claims: string[];
	/** Autowork is on: the arbiter keeps offering the next ready task. */
	autowork: boolean;
}

const KEY = Symbol.for("unipi.kanboard.status");

type Holder = { status?: SharedKanboardStatus | undefined };

function holder(): Holder {
	const g = globalThis as { [KEY]?: Holder };
	g[KEY] ??= {};
	return g[KEY] as Holder;
}

/** Publish the current claims/autowork snapshot (undefined clears it). */
export function setSharedKanboardStatus(status: SharedKanboardStatus | undefined): void {
	holder().status = status;
}

/** Read the current snapshot, or undefined when kanboard never published. */
export function getSharedKanboardStatus(): SharedKanboardStatus | undefined {
	return holder().status;
}

/** Glance label for a snapshot: `▣ UNI-30`, `▣ UNI-30 +1`, `▣ autowork`,
 *  `▣ UNI-30 · autowork`. Null when there is nothing to show. */
export function kanboardGlanceLabel(status: SharedKanboardStatus | null | undefined): string | null {
	if (!status) return null;
	const { claims, autowork } = status;
	if (claims.length === 0 && !autowork) return null;
	const claimPart =
		claims.length === 0 ? null : claims.length === 1 ? claims[0]! : `${claims[0]} +${String(claims.length - 1)}`;
	const autoworkPart = autowork ? "autowork" : null;
	const body = [claimPart, autoworkPart].filter(Boolean).join(" · ");
	return `▣ ${body}`;
}
