/**
 * `/unipi:visualize-progress` (UNI-222) — opens the live progress view as an
 * overlay. Esc / q closes. Subscribes to the sticky LH_PROGRESS bus event
 * (replayed at once, so frame 0 is the current state) and to the shared
 * 90 ms ticker for spinners; both stop when the overlay closes.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { bus, subscribeTick, UNIPI_EVENTS, type KitTheme, type LhProgressEvent } from "@pi-unipi/core";
import { progressViewHeight, renderProgressView } from "./progress-view.js";

export const VISUALIZE_COMMAND = "unipi:visualize-progress";

/** Overlay height in rows for a terminal of `rows` rows. */
export function viewHeight(rows: number): number {
  return Math.max(8, Math.min(rows - 2, 48));
}

export function registerVisualizeProgress(pi: ExtensionAPI): void {
  pi.registerCommand(VISUALIZE_COMMAND, {
    description: "Live view of the goal / ralph / swarm / graph run (Esc or q closes)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        const p = bus.get(UNIPI_EVENTS.LH_PROGRESS);
        const run = p?.current ?? p?.last;
        ctx.ui.notify(run ? `${run.mode}: ${run.title} — ${run.counts.done}/${run.counts.total} done (${run.status})` : "No long-horizon mode active.", "info");
        return;
      }
      openProgressView(pi, ctx);
    },
  });
}

function openProgressView(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  void ctx.ui.custom<void>(
    (tui, theme, _kb, done) => {
      let progress: LhProgressEvent | undefined = bus.get(UNIPI_EVENTS.LH_PROGRESS);
      const unsubBus = bus.on(pi, UNIPI_EVENTS.LH_PROGRESS, (next) => {
        progress = next;
        tui.requestRender();
      });
      // Fast tempo (spinners) only while something runs; a 1 s tick keeps "updated Ns ago" honest otherwise.
      let lastSlow = 0;
      const unsubTick = subscribeTick(() => {
        const now = Date.now();
        if (progress?.current?.status === "running" || now - lastSlow >= 1000) {
          lastSlow = now;
          tui.requestRender();
        }
      });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubTick();
        unsubBus();
        done();
      };
      const rows = () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
      return {
        render: (width: number) =>
          renderProgressView(theme as unknown as KitTheme, progress, width, progressViewHeight(progress, width, viewHeight(rows())), Date.now()),
        invalidate: () => {},
        handleInput: (data: string) => {
          if (data === "q" || data === "Q" || matchesKey(data, Key.escape)) close();
        },
        dispose: () => {
          if (!closed) {
            closed = true;
            unsubTick();
            unsubBus();
          }
        },
      };
    },
    {
      overlay: true,
      overlayOptions: () => ({ width: "94%", minWidth: 40, maxHeight: "96%", anchor: "center" as const, margin: 1 }),
    },
  );
}
