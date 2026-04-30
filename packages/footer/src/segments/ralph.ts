/**
 * @pi-unipi/footer — Ralph segments
 *
 * Segment renderers for the ralph group: active_loops, total_iterations, loop_status.
 * Data sourced from RALPH_LOOP_START/END/ITERATION_DONE events via registry cache.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getRalphData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

function renderActiveLoopsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getRalphData(ctx);
  const active = data.active === true;
  const name = data.name;
  if (!active && !name) return { content: "", visible: false };

  const content = withIcon("activeLoops", active ? "▶" : "—");
  return { content: applyColor("ralph", content, ctx.theme, ctx.colors), visible: true };
}

function renderTotalIterationsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getRalphData(ctx);
  const lastIteration = data.lastIteration as Record<string, unknown> | undefined;
  const iteration = data.iteration ?? lastIteration?.iteration;
  if (iteration === undefined || iteration === null) return { content: "", visible: false };
  const maxIterations = data.maxIterations;
  const display = maxIterations ? `${iteration}/${maxIterations}` : `${iteration}`;
  const content = withIcon("totalIterations", display);
  return { content: applyColor("ralph", content, ctx.theme, ctx.colors), visible: true };
}

function renderLoopStatusSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getRalphData(ctx);
  const status = data.status as string | undefined;
  const name = data.name as string | undefined;
  if (!status && !name) return { content: "", visible: false };

  const statusIcon = status === "active" ? "▶" : status === "paused" ? "⏸" : status === "completed" ? "✓" : "—";
  const display = name ? `${statusIcon} ${name}` : statusIcon;
  const content = withIcon("loopStatus", display);
  return { content: applyColor("ralph", content, ctx.theme, ctx.colors), visible: true };
}

export const RALPH_SEGMENTS: FooterSegment[] = [
  { id: "active_loops", label: "Active Loops", icon: "", render: renderActiveLoopsSegment, defaultShow: true },
  { id: "total_iterations", label: "Total Iterations", icon: "", render: renderTotalIterationsSegment, defaultShow: true },
  { id: "loop_status", label: "Loop Status", icon: "", render: renderLoopStatusSegment, defaultShow: true },
];
