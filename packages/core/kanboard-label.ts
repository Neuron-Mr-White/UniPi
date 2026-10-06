/**
 * @pi-unipi/core — kanboard glance label
 *
 * Pure label for the footer's glance title, typed on the bus's
 * KanboardStatusEvent (kanboard publishes via UNIPI_EVENTS.KANBOARD_STATUS).
 */

import type { KanboardStatusEvent } from "./bus.js";

/** Glance label for a snapshot: `▣ UNI-30`, `▣ UNI-30 +1`, `▣ autowork`,
 *  `▣ UNI-30 · autowork`. Null when there is nothing to show. */
export function kanboardGlanceLabel(status: KanboardStatusEvent | null | undefined): string | null {
	if (!status) return null;
	const { claims, autowork } = status;
	if (claims.length === 0 && !autowork) return null;
	const claimPart =
		claims.length === 0 ? null : claims.length === 1 ? claims[0]! : `${claims[0]} +${String(claims.length - 1)}`;
	const autoworkPart = autowork ? "autowork" : null;
	const body = [claimPart, autoworkPart].filter(Boolean).join(" · ");
	return `▣ ${body}`;
}

/** Board contract for compaction contexts / goal continuations (UNI-123):
 *  the finish-or-block duties for this session's claims. Null when the board
 *  is clean or kanboard never published. */
export function kanboardClaimsReminder(status: KanboardStatusEvent | null | undefined): string | null {
	if (!status || status.claims.length === 0) return null;
	const cli = status.cli ?? "unipi-kanboard";
	const ids = status.claims.join(", ");
	return `Kanboard: this session holds ${ids} In Progress. Never leave a claimed task In Progress — when its work is done run \`${cli} finish <ID> --comment "<summary>"\`, or \`${cli} move <ID> blocked --comment "<what you need>"\` if you are stuck. Read a task with \`${cli} show <ID>\`.`;
}
