/**
 * `/unipi:visualize-progress` (UNI-222) — opens the live progress view as an
 * overlay. Esc / q closes. Subscribes to the sticky LH_PROGRESS bus event
 * (replayed at once, so frame 0 is the current state) and to the shared
 * 90 ms ticker for spinners; both stop when the overlay closes.
 *
 * Chart mode (UNI-258): on a Kitty-graphics terminal a graph/swarm run is
 * drawn as the mermaid chart the app shows (progress-mermaid.ts → PNG via
 * progress-chart.ts) above the log; `m` toggles chart/text. Text stays the
 * fallback when the terminal has no inline images, the run has no chart, or
 * the renderer is unavailable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { bus, subscribeTick, UNIPI_EVENTS, type KitTheme, type LhProgressEvent } from "@pi-unipi/core";
import { progressViewHeight, renderProgressView, type ProgressChartSlot } from "./progress-view.js";
import { allocateImageId, chartCellSize, chartImageLines, chartRendererError, chartSupported, LiveChart } from "./progress-chart.js";
import { hasProgressChart } from "./progress-mermaid.js";

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
      const chartState = createChartState(() => tui.requestRender());
      chartState.update(progress);
      const unsubBus = bus.on(pi, UNIPI_EVENTS.LH_PROGRESS, (next) => {
        progress = next;
        chartState.update(progress);
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
        chartState.dispose();
        done();
      };
      const rows = () => (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 40;
      return {
        render: (width: number) => {
          const slot = chartState.slot(progress);
          return renderProgressView(theme as unknown as KitTheme, progress, width, progressViewHeight(progress, width, viewHeight(rows()), !!slot?.active), Date.now(), slot);
        },
        invalidate: () => {},
        handleInput: (data: string) => {
          if (data === "q" || data === "Q" || matchesKey(data, Key.escape)) close();
          else if (data === "m" || data === "M") {
            chartState.toggle();
            tui.requestRender();
          }
        },
        dispose: () => {
          if (!closed) {
            closed = true;
            unsubTick();
            unsubBus();
            chartState.dispose();
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

/**
 * The overlay's chart mode: whether it is on, the live PNG, and the slot the
 * view draws. Exported for tests.
 */
export function createChartState(requestRender: () => void, supported = chartSupported()) {
  let on = supported;
  const live = new LiveChart(requestRender);
  const imageId = allocateImageId();
  let lastRun: Parameters<LiveChart["update"]>[0];
  return {
    get on() {
      return on;
    },
    update(progress: LhProgressEvent | undefined) {
      lastRun = progress?.current ?? progress?.last;
      if (on) live.update(lastRun);
    },
    toggle() {
      on = !on;
      if (on) live.update(lastRun);
    },
    /** The view's chart slot; `active` = an image is drawn (the frame grows to full height). */
    slot(progress: LhProgressEvent | undefined): (ProgressChartSlot & { active: boolean }) | undefined {
      const run = progress?.current ?? progress?.last;
      if (!hasProgressChart(run)) return undefined;
      if (!supported) return undefined;
      const error = live.error ?? chartRendererError() ?? undefined;
      if (!on) return { active: false, hint: "m chart", image: () => undefined };
      if (error && !live.frame) return { active: false, hint: `chart unavailable: ${error}`, image: () => undefined };
      const frame = live.frame;
      return {
        active: !!frame,
        hint: frame ? "m text" : "m text · rendering chart…",
        image: (cols, rows) => {
          if (!frame) return undefined;
          const size = chartCellSize(frame, cols, rows);
          return { lines: chartImageLines(frame, size.columns, size.rows, imageId), columns: size.columns };
        },
      };
    },
    dispose() {
      live.dispose();
    },
  };
}
