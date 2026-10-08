/**
 * Shared animation ticker (UNI-133 "fps drop while subagents run").
 *
 * Before: every live card/widget that wants a spinner to animate owned its
 * OWN `setInterval(…, SPINNER_MS)` (subagents/src/cards.ts — one timer PER
 * running run_subagent card — and the subagents FG live-tail widget, each
 * independently calling `tui.requestRender()` / `context.invalidate()`).
 * With several subagents running in the foreground that's N independent
 * 90 ms timers, each triggering its own re-render pass; a session with a
 * handful of concurrent cards can tick several renders per 90 ms window
 * instead of one, competing with the editor's own loader/colour animation
 * for frame budget.
 *
 * After: ONE `setInterval` per process, started on the first subscriber and
 * stopped when the last one leaves; every subscriber's callback runs off
 * that single tick. Re-render work itself is unchanged (each widget still
 * decides what to redraw) — only the number of timers driving it drops from
 * N to 1.
 */

export type TickListener = () => void;

const KEY = Symbol.for("unipi.tui.shared-ticker");

interface TickerHolder {
  listeners: Set<TickListener>;
  timer: ReturnType<typeof setInterval> | undefined;
  intervalMs: number;
}

function holder(): TickerHolder {
  const g = globalThis as unknown as { [KEY]?: TickerHolder };
  g[KEY] ??= { listeners: new Set(), timer: undefined, intervalMs: 90 };
  return g[KEY] as TickerHolder;
}

function tick(h: TickerHolder): void {
  for (const listener of [...h.listeners]) {
    try {
      listener();
    } catch {
      // A broken subscriber must never stop the others' animation.
    }
  }
}

/**
 * Subscribe to the shared animation tick (default 90 ms, matches
 * `SPINNER_MS`). The underlying timer starts on the first subscriber and is
 * cleared once the last one unsubscribes — idle sessions pay nothing.
 * Returns the unsubscribe function.
 */
export function subscribeTick(listener: TickListener, intervalMs?: number): () => void {
  const h = holder();
  h.listeners.add(listener);
  if (intervalMs !== undefined && h.listeners.size === 1) h.intervalMs = intervalMs;
  if (h.timer === undefined) {
    h.timer = setInterval(() => tick(h), h.intervalMs);
    h.timer.unref?.();
  }
  return () => {
    h.listeners.delete(listener);
    if (h.listeners.size === 0 && h.timer !== undefined) {
      clearInterval(h.timer);
      h.timer = undefined;
    }
  };
}

/** Number of live subscribers — tests only. */
export function sharedTickerSubscriberCount(): number {
  return holder().listeners.size;
}

/** Test hook: drop every subscription and the timer. */
export function resetSharedTickerForTests(): void {
  const h = holder();
  if (h.timer !== undefined) clearInterval(h.timer);
  h.timer = undefined;
  h.listeners.clear();
  h.intervalMs = 90;
}
