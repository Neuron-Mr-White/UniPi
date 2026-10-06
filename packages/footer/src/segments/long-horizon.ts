/**
 * @pi-unipi/footer — Long-horizon mode labels
 *
 * Maps the mode ids carried by LONG_HORIZON_MODE_RESOLVED / the bus's sticky
 * LH_STATE to display labels: "Goal Mode" · "Ralph Mode" · "Swarm Mode" ·
 * "Graph Mode" · "Regular Mode".
 */

import type { LhStateEvent } from "@pi-unipi/core";

export const MODE_LABELS: Record<string, string> = {
  goal: "Goal Mode",
  ralph: "Ralph Mode",
  swarm: "Swarm Mode",
  graph: "Graph Mode",
  none: "Regular Mode",
};

/** Glance title for the bus's sticky LH_STATE payload. A parked owner while
 *  the session is regular shows "<Mode> · paused". Null without state. */
export function lhModeLabel(state?: LhStateEvent): string | null {
  if (!state) return null;
  if (state.paused && state.mode === "none") return `${MODE_LABELS[state.paused] ?? state.paused} · paused`;
  return MODE_LABELS[state.mode] ?? state.mode;
}
