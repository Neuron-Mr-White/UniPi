/**
 * Long-horizon sticky footer state — the ONE publish point (UNI-122).
 *
 * index.ts publishes LH_STATE from this pure shape whenever the owner
 * lifecycle or the gate's display mode changes: the active owner's mode wins;
 * otherwise the gate's display mode (last resolved turn mode / session
 * override / default). A parked owner surfaces as `paused` so the footer can
 * show "<Mode> · paused" while the session is regular.
 */

import type { LhStateEvent } from "@pi-unipi/core";
import { modeForOwnerKind, type LhMode } from "./modes.js";
import type { OwnerState } from "./owner.js";

/** Terminal owner stop, as carried by LhStateEvent.lastStop. */
export interface OwnerStop {
  kind: "complete" | "paused" | "budget" | "other";
  at: number;
}

/** The LH_STATE payload for the current coordinator + gate display state. */
export function lhStateFrom(
  active: OwnerState | undefined,
  parked: OwnerState | undefined,
  stop: OwnerStop | undefined,
  displayMode: LhMode,
): LhStateEvent {
  return {
    mode: active ? modeForOwnerKind(active.kind) : displayMode,
    ...(parked ? { paused: modeForOwnerKind(parked.kind) } : {}),
    ...(active
      ? { owner: { kind: active.kind, status: "active" as const } }
      : parked
        ? { owner: { kind: parked.kind, status: "parked" as const } }
        : {}),
    ...(stop ? { lastStop: stop } : {}),
  };
}
