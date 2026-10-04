/**
 * @pi-unipi/info-screen — page identity: tab label, accent colour, order.
 *
 * One table so the tab strip, borders and page headers agree, and so module
 * packages don't each invent priorities (two pages used to share 20 and 50,
 * and their tab order then depended on load order).
 */

import { CRAB, type RGB } from "@pi-unipi/core";

export interface PageStyle {
  short: string;
  accent: RGB;
  priority: number;
}

export const PAGE_STYLES: Record<string, PageStyle> = {
  session: { short: "Session", accent: CRAB.orange, priority: 10 },
  usage: { short: "Usage", accent: CRAB.gold, priority: 20 },
  tools: { short: "Tools", accent: [0, 200, 240], priority: 30 },
  skills: { short: "Skills", accent: [190, 150, 240], priority: 40 },
  extensions: { short: "Modules", accent: [110, 150, 255], priority: 50 },
  mcp: { short: "MCP", accent: [120, 210, 120], priority: 60 },
  compactor: { short: "Compactor", accent: [78, 201, 176], priority: 70 },
  memory: { short: "Memory", accent: [240, 200, 110], priority: 80 },
  "web-api": { short: "Web", accent: [230, 120, 200], priority: 90 },
  updater: { short: "Updates", accent: [250, 160, 60], priority: 100 },
  "input-shortcuts": { short: "Keys", accent: [140, 190, 180], priority: 115 },
};

/** Stable colour for an unknown page id (hash → hue). */
export function accentFor(id: string): RGB {
  const known = PAGE_STYLES[id];
  if (known) return known.accent;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = (h % 360) / 60;
  const x = 1 - Math.abs((hue % 2) - 1);
  const [r, g, b] = hue < 1 ? [1, x, 0] : hue < 2 ? [x, 1, 0] : hue < 3 ? [0, 1, x] : hue < 4 ? [0, x, 1] : hue < 5 ? [x, 0, 1] : [1, 0, x];
  return [Math.round(90 + r * 150), Math.round(90 + g * 150), Math.round(90 + b * 150)];
}

/** Lighter / darker variants for ramps. */
export function shade(c: RGB, k: number): RGB {
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))));
  return [f(c[0]), f(c[1]), f(c[2])];
}

/** A 3-stop ramp around a page accent: deep → accent → light. */
export function accentRamp(c: RGB): RGB[] {
  return [shade(c, -0.35), c, shade(c, 0.45)];
}

/**
 * Scope of a number: s = this session, p = this project (workspace),
 * g = global (every project on this machine).
 */
export type Scope = "s" | "p" | "g";
export const SCOPE_COLOR: Record<Scope, RGB> = {
  s: [0, 200, 240],
  p: [120, 200, 120],
  g: [240, 180, 60],
};
export const SCOPE_WORD: Record<Scope, string> = { s: "session", p: "project", g: "global" };

/**
 * Which snapshot a page persists to: "session" pages are never saved,
 * "project" pages per workspace, "global" pages once per machine.
 */
export const PAGE_SCOPE: Record<string, "session" | "project" | "global"> = {
  session: "session",
  memory: "project",
  mcp: "project",
  compactor: "project",
};

/** Opaque panel background of every info surface. */
export const PANEL_BG: RGB = [22, 24, 30];
/** Slightly raised background for chips/cards inside the panel. */
export const CARD_BG: RGB = [34, 37, 46];
