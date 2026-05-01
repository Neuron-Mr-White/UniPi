/**
 * Line width safety — width clamping with collapsed hints
 *
 * Uses ANSI-aware visibleWidth measurement from pi-tui to properly
 * handle lines containing escape codes. Falls back to raw-length
 * measurement when pi-tui is unavailable.
 */

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

/**
 * Clamp each line to maxWidth visible columns.
 * Uses pi-tui's visibleWidth() for ANSI-aware measurement and
 * truncateToWidth() for ANSI-safe truncation.
 */
export function clampLineWidth(lines: string[], maxWidth: number): string[] {
  return lines.map((line) => {
    const vw = visibleWidth(line);
    if (vw <= maxWidth) return line;
    return truncateToWidth(line, maxWidth, "…");
  });
}

export function collapseHint(originalCount: number, shownCount: number): string {
  const omitted = originalCount - shownCount;
  if (omitted <= 0) return "";
  return `...(${omitted} more lines)...`;
}
