/**
 * Shared display rendering utilities
 */

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function countNonEmptyLines(text: string): number {
  return splitLines(text).filter((l) => l.trim()).length;
}

export function compactOutputLines(text: string, maxLines: number): string {
  const lines = splitLines(text);
  if (lines.length <= maxLines) return text;
  const omitted = lines.length - maxLines;
  return `...(${omitted} lines omitted)...\n${lines.slice(-maxLines).join("\n")}`;
}

export function previewLines(text: string, lines: number): string {
  const all = splitLines(text);
  if (all.length <= lines) return text;
  return all.slice(0, lines).join("\n") + `\n...(${all.length - lines} more lines)`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${plural ?? singular + "s"}`;
}

export function shortenPath(path: string, maxLen: number = 60): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return "..." + path.slice(-(maxLen - 3));
  return parts[0] + "/.../" + parts.slice(-2).join("/");
}

export function extractTextOutput(result: any): string {
  if (typeof result === "string") return result;
  if (result?.output) return String(result.output);
  if (result?.stdout) return String(result.stdout);
  return "";
}

export function isLikelyQuietCommand(command: string): boolean {
  const quietPatterns = [/^\s*cd\s/, /^\s*mkdir\s+-p/, /^\s*touch\s/, /^\s*rm\s+/];
  return quietPatterns.some((re) => re.test(command));
}

export function sanitizeAnsiForThemedOutput(text: string): string {
  // Strip ANSI escape sequences for clean themed rendering
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
