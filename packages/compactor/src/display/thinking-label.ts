/**
 * Thinking labels during streaming
 */

export function formatThinkingLabel(text: string, opts?: { prefix?: string }): string {
  const prefix = opts?.prefix ?? "🤔";
  const lines = text.split("\n");
  if (lines.length === 1) return `${prefix} ${lines[0]}`;
  return `${prefix} Thinking...\n${text}`;
}

export function sanitizeThinkingArtifacts(text: string): string {
  // Remove thinking blocks from context before LLM turn
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/\[thinking\][\s\S]*?\[\/thinking\]/g, "")
    .trim();
}
