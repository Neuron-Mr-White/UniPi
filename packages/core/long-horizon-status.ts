/**
 * @pi-unipi/core — shared long-horizon mode status
 *
 * The long-horizon package owns the active automation mode (goal/ralph/swarm/
 * graph/none); the footer package owns the glance title that should display it.
 * Same Symbol.for global pattern as fusion-status: the mode is published
 * whenever it resolves (before_agent_start) AND restored on session_start, and
 * the footer PULLS it every render.
 *
 * Why a pull, not an event: on resume (`pi -r`) no turn starts, so a one-shot
 * event can race the footer's own session_start subscription and be dropped.
 * A shared getter the footer reads each render tick is timing-independent.
 */

const KEY = Symbol.for("unipi.longHorizon.mode");

type Holder = { mode?: string | undefined };

function holder(): Holder {
  const g = globalThis as { [KEY]?: Holder };
  g[KEY] ??= {};
  return g[KEY] as Holder;
}

/** Publish the current mode id (e.g. "goal"). Pass undefined to clear. */
export function setSharedLongHorizonMode(mode: string | undefined): void {
  holder().mode = mode;
}

/** Read the current mode id, or undefined when no mode is active/known. */
export function getSharedLongHorizonMode(): string | undefined {
  return holder().mode;
}
