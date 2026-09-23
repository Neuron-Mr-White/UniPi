/**
 * @pi-unipi/core — Package identity colors
 *
 * Moved from command-enchantment constants so the /unipi:settings hub paints
 * the same per-package identity as the autocomplete list. `namespaceColor`
 * maps a settings-hub namespace onto its package color: aliases first
 * ("command-enchantment" → "autocomplete", "info-screen" → "info",
 * "compactor" → "compact"), then the namespace itself. Unknown namespaces
 * return "" — callers render them uncolored.
 */

const ESC = "\x1b";
const RESET = `${ESC}[0m`;

/** Wrap text in an ANSI color code */
export function colorize(ansiCode: string, text: string): string {
  return `${ansiCode}${text}${RESET}`;
}

// ─── Package Colors ──────────────────────────────────────────────────
/** ANSI bright-color codes per package */
export const PACKAGE_COLORS: Record<string, string> = {
  autocomplete: `${ESC}[97m`, // Bright White (hub groups; only unused bright code)
  workflow:  `${ESC}[91m`, // Bright Red
  "long-horizon": `${ESC}[33m`, // Yellow/Orange
  memory:    `${ESC}[93m`, // Bright Yellow
  btw:       `${ESC}[95m`, // Bright Magenta
  mcp:       `${ESC}[32m`, // Green
  utility:   `${ESC}[36m`, // Cyan
  "ask-user": `${ESC}[94m`, // Bright Blue
  info:      `${ESC}[35m`, // Magenta
  "web-api": `${ESC}[95m`, // Bright Magenta
  compact:   `${ESC}[37m`, // White
  notify:    `${ESC}[96m`, // Bright Cyan
  kanboard:  `${ESC}[92m`, // Bright Green
  footer:    `${ESC}[34m`, // Blue
  updater:   `${ESC}[93m`, // Bright Yellow
  "input-shortcuts": `${ESC}[95m`, // Bright Magenta
  image:     `${ESC}[35m`, // Magenta
  subagents: `${ESC}[34m`, // Blue
  "background-tasks": `${ESC}[91m`, // Bright Red
  fusion:    `${ESC}[96m`, // Bright Cyan
  watchdog:  `${ESC}[90m`, // Bright Black (gray)
};

/** Hub namespace → PACKAGE_COLORS key (others use the namespace identity). */
const NAMESPACE_COLOR_KEYS: Record<string, string> = {
  "command-enchantment": "autocomplete",
  "info-screen": "info",
  compactor: "compact",
};

/** ANSI color for a settings namespace ("" when unknown — no color). */
export function namespaceColor(namespace: string): string {
  const key = NAMESPACE_COLOR_KEYS[namespace] ?? namespace;
  return PACKAGE_COLORS[key] ?? "";
}
