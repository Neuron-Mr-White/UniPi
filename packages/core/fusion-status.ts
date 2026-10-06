/**
 * @pi-unipi/core — shared Fusion display status
 *
 * The fusion package owns the active lead/sidekick selection; the footer
 * package owns the input-box frame that should display it. Same pattern as
 * background-tasks' shared registry: a Symbol.for global published at
 * extension init / session start and cleared on shutdown.
 */

import type { FusionStatusEvent } from "./bus.js";

/**
 * @deprecated Use `FusionStatusEvent` from the central bus (`bus.ts`). Kept as an
 * alias so existing pull-only consumers keep compiling until the bus is wired.
 */
export type SharedFusionStatus = FusionStatusEvent;

const KEY = Symbol.for("unipi.fusion.status");

type Holder = { status?: SharedFusionStatus | undefined };

function holder(): Holder {
  const g = globalThis as { [KEY]?: Holder };
  g[KEY] ??= {};
  return g[KEY] as Holder;
}

export function setSharedFusionStatus(status: SharedFusionStatus | undefined): void {
  holder().status = status;
}

export function getSharedFusionStatus(): SharedFusionStatus | undefined {
  return holder().status;
}
