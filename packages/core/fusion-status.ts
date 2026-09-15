/**
 * @pi-unipi/core — shared Fusion display status
 *
 * The fusion package owns the active lead/sidekick selection; the footer
 * package owns the input-box frame that should display it. Same pattern as
 * background-tasks' shared registry: a Symbol.for global published at
 * extension init / session start and cleared on shutdown.
 */

export interface SharedFusionStatus {
  /** Display name of the lead (the session model). */
  leadName: string;
  /** Lead thinking level, e.g. "medium". */
  leadEffort: string;
  /** Display name of the sidekick. */
  sidekickName: string;
  /** Sidekick thinking level. */
  sidekickEffort: string;
  /** Estimated savings compared with pricing all sidekick usage at lead rates. */
  savedUsd?: number;
}

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
