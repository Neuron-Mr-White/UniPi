/**
 * @pi-unipi/footer — Long-horizon mode segment
 *
 * Renders the active long-horizon mode right beside the UNIPI brand mark:
 * "Goal Mode" · "Ralph Mode" · "Swarm Mode" · "Graph Mode" · "Regular Mode".
 *
 * The segment lives in the CORE group (for placement) but reads a module
 * store fed by LONG_HORIZON_MODE_RESOLVED events — group-data binding would
 * require it to live in its own group, which lands it after the whole core
 * block. Hidden until the first mode event arrives, so sessions without
 * long-horizon installed show nothing.
 */

import type { FooterSegment, FooterSegmentContext, RenderedSegment } from "../types.js";
import { applyColor } from "../rendering/theme.js";

export const MODE_LABELS: Record<string, string> = {
  goal: "Goal Mode",
  ralph: "Ralph Mode",
  swarm: "Swarm Mode",
  graph: "Graph Mode",
  none: "Regular Mode",
};

/** Last mode resolved this session (null = no event yet → segment hidden). */
let currentMode: string | null = null;

export function setFooterMode(mode: string): void {
  currentMode = mode;
}

export function getFooterMode(): string | null {
  return currentMode;
}

function renderModeSegment(ctx: FooterSegmentContext): RenderedSegment {
  if (currentMode === null) return { content: "", visible: false };
  const label = MODE_LABELS[currentMode] ?? currentMode;
  return { content: applyColor("model", label, ctx.theme, ctx.colors), visible: true };
}

export const LONG_HORIZON_SEGMENTS: FooterSegment[] = [
  {
    id: "lh_mode",
    label: "Mode",
    shortLabel: "MODE",
    description: "Active long-horizon mode (Goal/Ralph/Swarm/Graph/Regular)",
    zone: "left",
    render: renderModeSegment,
    defaultShow: true,
  },
];
