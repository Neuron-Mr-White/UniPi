/**
 * @pi-unipi/footer — Ralph segments
 *
 * Segment renderers for the ralph group: active_loops, total_iterations, loop_status.
 * Data sourced from RALPH_LOOP_START/END/ITERATION_DONE events via registry cache.
 *
 * Display logic:
 * - When loop is active: green dot ● + iteration stats (e.g. 1/3)
 * - When loop is off: red dot ●
 * - Uses 󰼉 icon for the ralph group
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment, SemanticColor } from "../types.js";
import { applyColor, mutedPlaceholder } from "../rendering/theme.js";
import { getIcon } from "../rendering/icons.js";
import { isSegmentEnabled } from "../config.js";



/** Green dot indicator (with explicit ANSI codes) */
const GREEN_DOT = "\x1b[38;5;82m●\x1b[0m";
/** Red dot indicator (with explicit ANSI codes) */
const RED_DOT = "\x1b[38;5;196m●\x1b[0m";

const ANSI_RESET = "\x1b[0m";

function withIcon(segmentId: string, text: string): string {
  const icon = getIcon(segmentId);
  return icon ? `${icon} ${text}` : text;
}

function getRalphData(ctx: FooterSegmentContext): Record<string, unknown> {
  const data = ctx.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

/** Apply semantic color to plain text (without overriding embedded ANSI codes) */
function colorText(ctx: FooterSegmentContext, semantic: SemanticColor, text: string): string {
  return applyColor(semantic, text, ctx.theme, ctx.colors);
}

function renderActiveLoopsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getRalphData(ctx);
  const active = data.active === true;
  const name = data.name as string | undefined;
  const iteration = data.iteration as number | undefined;
  const maxIterations = data.maxIterations as number | undefined;

  // Always show when there's ralph data (even when off, to show red dot)
  if (!active && !name && iteration === undefined) {
    // Show muted placeholder when enabled but no data
    if (isSegmentEnabled("ralph", "active_loops")) {
      return { content: mutedPlaceholder("🔁 RL OFF"), visible: true };
    }
    return { content: "", visible: false };
  }

  const dot = active ? GREEN_DOT : RED_DOT;

  const ralphIcon = getIcon("activeLoops");

  if (active) {
    // Active: green dot + iteration stats
    const iterStr = iteration !== undefined
      ? (maxIterations ? `${iteration}/${maxIterations}` : `${iteration}`)
      : "";
    const nameStr = name ? ` ${name}` : "";
    // Color the icon and text parts, keep dot's own color
    const content = `${ralphIcon} ${dot} ${colorText(ctx, "ralphOn", `${iterStr}${nameStr}`)}`;
    return { content, visible: true };
  } else {
    // Off/inactive: red dot
    return { content: `${colorText(ctx, "ralphOff", ralphIcon)} ${dot}`, visible: true };
  }
}

function renderTotalIterationsSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getRalphData(ctx);
  const active = data.active === true;
  const lastIteration = data.lastIteration as Record<string, unknown> | undefined;
  const iteration = data.iteration ?? lastIteration?.iteration;
  if (iteration === undefined || iteration === null) {
    if (isSegmentEnabled("ralph", "total_iterations")) {
      return { content: mutedPlaceholder("🔁 RL 0"), visible: true };
    }
    return { content: "", visible: false };
  }
  const maxIterations = data.maxIterations;
  const display = maxIterations ? `${iteration}/${maxIterations}` : `${iteration}`;

  const ralphIcon = getIcon("activeLoops");
  const dot = active ? GREEN_DOT : RED_DOT;
  const semantic: SemanticColor = active ? "ralphOn" : "ralphOff";
  const content = `${colorText(ctx, semantic, ralphIcon)} ${dot} ${colorText(ctx, semantic, display)}`;
  return { content, visible: true };
}

function renderLoopStatusSegment(ctx: FooterSegmentContext): RenderedSegment {
  const data = getRalphData(ctx);
  const status = data.status as string | undefined;
  const name = data.name as string | undefined;
  if (!status && !name) {
    if (isSegmentEnabled("ralph", "loop_status")) {
      return { content: mutedPlaceholder("🔁 RL OFF"), visible: true };
    }
    return { content: "", visible: false };
  }

  const ralphIcon = getIcon("activeLoops");
  const dot = status === "active" ? GREEN_DOT : status === "completed" ? GREEN_DOT : RED_DOT;
  const statusIcon = status === "active" ? "▶" : status === "paused" ? "⏸" : status === "completed" ? "✓" : "";
  const display = name ? `${statusIcon} ${name}` : `${statusIcon}`;

  const active = status === "active" || status === "completed";
  const semantic: SemanticColor = active ? "ralphOn" : "ralphOff";
  const content = `${colorText(ctx, semantic, ralphIcon)} ${dot} ${colorText(ctx, semantic, display)}`;
  return { content, visible: true };
}

export const RALPH_SEGMENTS: FooterSegment[] = [
  { id: "active_loops", label: "Loops", shortLabel: "RL", description: "Active Ralph loops", zone: "center", icon: "", render: renderActiveLoopsSegment, defaultShow: true },
  { id: "total_iterations", label: "Iterations", shortLabel: "ITR", description: "Total Ralph loop iterations", zone: "center", icon: "", render: renderTotalIterationsSegment, defaultShow: true },
  { id: "loop_status", label: "Status", shortLabel: "STS", description: "Current loop status", zone: "center", icon: "", render: renderLoopStatusSegment, defaultShow: true },
];
