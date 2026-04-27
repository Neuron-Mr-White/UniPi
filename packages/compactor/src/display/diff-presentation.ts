/**
 * Diff presentation — layout selection based on terminal width
 */

import type { DiffLayout } from "../types.js";

export function selectDiffLayout(
  terminalWidth: number,
  preferred: DiffLayout = "auto",
): "split" | "unified" {
  if (preferred !== "auto") return preferred;
  return terminalWidth >= 100 ? "split" : "unified";
}

export function clampWidth(text: string, maxWidth: number): string {
  return text
    .split("\n")
    .map((line) => (line.length > maxWidth ? line.slice(0, maxWidth - 3) + "..." : line))
    .join("\n");
}
