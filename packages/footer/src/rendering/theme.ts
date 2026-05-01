/**
 * @pi-unipi/footer — Theme color resolution
 *
 * Maps semantic color names to pi theme colors. Supports
 * hex overrides via ColorScheme.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { ColorScheme, ColorValue, SemanticColor, ThemeLike } from "../types.js";

/** Default semantic-to-theme-color mapping */
const DEFAULT_COLOR_MAP: Record<SemanticColor, ThemeColor> = {
  // ── Model & Identity (Left zone) ──
  model: "accent",
  path: "text",
  git: "accent",
  gitClean: "success",
  gitDirty: "warning",
  session: "accent",
  worktree: "accent",
  // ── Workflow (Left zone) ──
  workflow: "accent",
  workflowNone: "dim",
  workflowBrainstorm: "warning",
  workflowPlan: "success",
  workflowWork: "accent",
  workflowReview: "muted",
  workflowAuto: "thinkingHigh",
  workflowDebug: "error",
  workflowChoreExec: "warning",
  workflowOther: "dim",
  // ── TPS tiers (Center zone) ──
  tpsSlow: "error",
  tpsModerate: "warning",
  tpsGood: "accent",
  tpsFast: "success",
  tpsBlazing: "thinkingHigh",
  tpsIdle: "dim",
  // ── Metrics (Center zone) ──
  compactor: "muted",
  memory: "accent",
  mcp: "success",
  ralph: "warning",
  ralphOn: "success",
  ralphOff: "error",
  kanboard: "dim",
  notify: "muted",
  context: "muted",
  contextWarn: "warning",
  contextError: "error",
  cost: "text",
  tokens: "muted",
  // ── Time (Right zone) ──
  clock: "text",
  duration: "accent",
  // ── Thinking levels ──
  thinking: "accent",
  thinkingMinimal: "thinkingMinimal",
  thinkingLow: "thinkingLow",
  thinkingMedium: "thinkingMedium",
  thinkingHigh: "thinkingHigh",
  thinkingXhigh: "thinkingXhigh",
  // ── UI chrome ──
  separator: "dim",
  border: "dim",
};

/**
 * Get the default color scheme mapping semantic names to theme colors.
 */
export function getDefaultColors(): ColorScheme {
  const scheme: ColorScheme = {};
  for (const [key, value] of Object.entries(DEFAULT_COLOR_MAP)) {
    scheme[key as SemanticColor] = value;
  }
  return scheme;
}

/**
 * Resolve a ColorValue to an actual color string using the theme.
 * If the value is a theme color name, uses theme.fg().
 * If it's a hex string, returns it directly.
 */
export function resolveColor(color: ColorValue, theme: ThemeLike): string {
  // Check if it's a hex color (starts with #)
  if (color.startsWith("#")) {
    return color;
  }
  // It's a ThemeColor — use theme.fg
  return theme.fg(color as ThemeColor, "").replace(/\x1b\[0m$/, "");
}

/**
 * Apply a semantic color to text using the theme.
 * Falls back to the default theme color if no override is provided.
 */
export function applyColor(
  semantic: SemanticColor,
  text: string,
  theme: ThemeLike,
  colors: ColorScheme,
): string {
  const colorValue = colors[semantic];
  if (!colorValue) {
    // Use default from the map
    const defaultColor = DEFAULT_COLOR_MAP[semantic] || "text";
    return theme.fg(defaultColor as ThemeColor, text);
  }

  if (colorValue.startsWith("#")) {
    // Hex color — we need to emit ANSI directly
    const hex = colorValue.slice(1);
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }

  return theme.fg(colorValue as ThemeColor, text);
}
