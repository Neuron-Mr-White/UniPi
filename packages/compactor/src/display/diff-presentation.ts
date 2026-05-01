/**
 * Diff presentation — layout selection based on terminal width
 */

import type { DiffLayout } from "../types.js";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";

export function selectDiffLayout(
  terminalWidth: number,
  preferred: DiffLayout = "auto",
): "split" | "unified" {
  if (preferred !== "auto") return preferred;
  return terminalWidth >= 100 ? "split" : "unified";
}

/** Clamp text to maxWidth visible columns, ANSI-aware */
export function clampWidth(text: string, maxWidth: number): string {
  return text
    .split("\n")
    .map((line) => {
      if (visibleWidth(line) <= maxWidth) return line;
      return truncateToWidth(line, maxWidth, "…");
    })
    .join("\n");
}
