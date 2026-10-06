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
