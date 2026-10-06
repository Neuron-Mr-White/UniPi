/**
 * kanboard ⇄ bus glue for the LEAD process (UNI-123).
 *
 * - kanboardCompactionContext: the board contract (finish / block / show for
 *   this session's claims) rides every compaction summary, so the agent keeps
 *   its duties after compaction summarizes the /unipi:kanboard-do message away.
 * - rearmOnOwnerResume: a goal pause disarms the settle monitor; when the
 *   parked long-horizon owner resumes, the monitor must come back.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bus, kanboardClaimsReminder, UNIPI_EVENTS } from "@pi-unipi/core";

/** Compaction-context provider: the board contract for this session's claims. */
export function kanboardCompactionContext(): string | null {
	return kanboardClaimsReminder(bus.get(UNIPI_EVENTS.KANBOARD_STATUS));
}

interface Armable {
	arm(reason?: string): void;
}

/** Re-arm the settle monitor when a parked owner resumes. Returns unsubscribe. */
export function rearmOnOwnerResume(pi: Pick<ExtensionAPI, "on">, monitor: Armable): () => void {
	return bus.on(pi, UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED, (e) => {
		if (e.event === "resumed") monitor.arm("owner resumed");
	});
}
