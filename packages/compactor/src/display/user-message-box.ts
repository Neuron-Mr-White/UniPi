/**
 * User message box — bordered display for user messages
 */

export function renderUserMessageBox(text: string, opts?: { maxWidth?: number }): string {
  const maxWidth = opts?.maxWidth ?? 80;
  const lines = text.split("\n");
  const clamped = lines.map((l) => (l.length > maxWidth - 4 ? l.slice(0, maxWidth - 7) + "..." : l));
  const width = Math.min(maxWidth, Math.max(...clamped.map((l) => l.length), 10) + 4);

  const top = `╭${"─".repeat(width - 2)}╮`;
  const bottom = `╰${"─".repeat(width - 2)}╯`;
  const middle = clamped.map((l) => `│ ${l.padEnd(width - 4)} │`);

  return [top, ...middle, bottom].join("\n");
}
