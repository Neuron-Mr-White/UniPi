/**
 * Diff width safety — truncate diff lines to terminal width
 *
 * Pi's renderDiff() in diff.js produces lines without width
 * truncation. When a diff line's visible content exceeds the
 * terminal width, the TUI crashes with:
 *   "Rendered line N exceeds terminal width (X > Y)"
 *
 * This module provides clampDiffToWidth() which truncates
 * each diff line to a safe width, preventing TUI crashes.
 *
 * The diff format from pi's generateDiffString() is:
 *   [+/-/ ]LINE_NUM CONTENT
 * e.g.: "+       38 │ The root cause is a **compound failure**..."
 *
 * We detect the terminal width from process.stdout and clamp
 * each line, accounting for the rendering overhead of the
 * edit tool's Box nesting (approx 4-6 chars of padding).
 */

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

/** Rendering overhead from Box nesting in edit tool components */
const RENDER_OVERHEAD = 6;

/** Minimum useful line width (don't clamp below this) */
const MIN_LINE_WIDTH = 20;

/**
 * Get the terminal width with fallback.
 * Uses process.stdout.columns (updated on resize).
 */
function getTerminalWidth(): number {
  return process.stdout?.columns ?? 80;
}

/**
 * Clamp a diff string so every line fits within terminal width.
 * Preserves the diff prefix (+/-/ ) and line number while
 * truncating the content portion.
 *
 * @param diff - The diff string from generateDiffString()
 * @param maxWidth - Override for terminal width (for testing)
 * @returns The clamped diff string (may be same reference if no clamping needed)
 */
export function clampDiffToWidth(
  diff: string,
  maxWidth?: number,
): string {
  const termW = maxWidth ?? getTerminalWidth();
  const safeW = Math.max(MIN_LINE_WIDTH, termW - RENDER_OVERHEAD);

  const lines = diff.split("\n");
  let changed = false;

  const result = lines.map((line) => {
    const vw = visibleWidth(line);
    if (vw <= safeW) return line;

    changed = true;

    // Try to preserve the diff prefix (+/-/ ) and line number
    // Format: [+/-/ ]LINE_NUM CONTENT
    // The prefix and line number are critical for readability
    const prefixMatch = line.match(/^([+\- ])\s*(\d*)\s/);
    if (prefixMatch) {
      const prefixLen = prefixMatch[0].length;
      // Calculate how much content we can keep
      const contentBudget = safeW - prefixLen;
      if (contentBudget >= MIN_LINE_WIDTH) {
        const prefix = line.slice(0, prefixLen);
        const content = line.slice(prefixLen);
        const truncated = truncateToWidth(content, contentBudget, "…");
        return prefix + truncated;
      }
    }

    // Fallback: truncate the entire line
    return truncateToWidth(line, safeW, "…");
  });

  return changed ? result.join("\n") : diff;
}
