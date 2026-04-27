/**
 * Line width safety — width clamping with collapsed hints
 */

export function clampLineWidth(lines: string[], maxWidth: number): string[] {
  return lines.map((line) => {
    if (line.length <= maxWidth) return line;
    return line.slice(0, maxWidth - 3) + "...";
  });
}

export function collapseHint(originalCount: number, shownCount: number): string {
  const omitted = originalCount - shownCount;
  if (omitted <= 0) return "";
  return `...(${omitted} more lines)...`;
}
