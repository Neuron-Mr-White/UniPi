/**
 * @pi-unipi/footer — Theme color resolution
 *
 * Maps semantic color names to pi theme colors. Supports
 * hex overrides via ColorScheme.
 */

import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import type { ColorScheme, ColorValue, SemanticColor, ThemeLike } from "../types.js";

/** Default semantic-to-theme-color mapping */
const DEFAULT_COLOR_MAP: Record<SemanticColor, ThemeColor | `#${string}`> = {
  // ── Model & Identity (Left zone) ──
  model: "#c792ea",           // Soft purple — model name
  path: "text",
  git: "#82cc6f",            // Green (clean default)
  gitClean: "#82cc6f",       // Green — clean branch
  gitDirty: "#e5c07b",       // Amber — dirty branch
  session: "#61afef",        // Blue — session name
  worktree: "#61afef",       // Blue — worktree indicator
  // ── Workflow (Left zone) ──
  workflow: "#c792ea",       // Purple (default)
  workflowNone: "#4a6a7a",   // Muted teal — idle
  workflowBrainstorm: "#e06c75", // Red
  workflowPlan: "#d19a66",   // Orange
  workflowWork: "#e5c07b",   // Yellow
  workflowReview: "#82cc6f", // Green
  workflowAuto: "#c792ea",   // Purple
  workflowDebug: "#e06c75",  // Red
  workflowChoreExec: "#d19a66", // Orange
  workflowOther: "#c792ea",  // Purple
  // ── TPS tiers (Center zone) ──
  tpsSlow: "#e06c75",        // Red — < 30 t/s
  tpsModerate: "#e5c07b",    // Amber — 30-50 t/s
  tpsGood: "#56d4bc",        // Teal — 50-100 t/s
  tpsFast: "#82cc6f",        // Green — 100-200 t/s
  tpsBlazing: "#c792ea",     // Purple — > 200 t/s
  tpsIdle: "#4a6a7a",        // Muted teal — session avg when idle
  // ── Metrics (Center zone) ──
  compactor: "#56b6c2",      // Cyan — compaction stats
  memory: "#61afef",         // Blue — memory count
  mcp: "#82cc6f",            // Green — MCP status
  ralph: "#e5c07b",          // Amber — ralph loops
  ralphOn: "#82cc6c",        // Green — ralph active
  ralphOff: "#e06c75",       // Red — ralph inactive
  kanboard: "#c678dd",       // Purple — kanboard
  notify: "#56b6c2",         // Cyan — notifications
  context: "muted",          // Theme token for OK context
  contextWarn: "#e5c07b",    // Amber — context 70-90%
  contextError: "#e06c75",   // Red — context > 90%
  cost: "#d19a66",           // Gold — cost
  tokens: "#abb2bf",         // Silver — token counts
  // ── Time (Right zone) ──
  clock: "#abb2bf",          // Silver — wall clock
  duration: "#61afef",       // Blue — session duration
  // ── Thinking levels ──
  thinking: "#61afef",
  thinkingMinimal: "#56b6c2", // Cyan
  thinkingLow: "#61afef",    // Blue
  thinkingMedium: "#c792ea", // Purple
  thinkingHigh: "#d19a66",   // Gold
  thinkingXhigh: "#e06c75",  // Red
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
