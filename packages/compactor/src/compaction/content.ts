/**
 * Content helpers for compaction pipeline
 */

/** Extract plain text from message content */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return "[thinking]";
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n");
  }
  return "";
}

/** Clip text to max length, adding ellipsis */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

/** Clip to first sentence within max length */
export function clipSentence(text: string, max: number): string {
  const trimmed = text.trim();
  const sentenceEnd = trimmed.search(/[.!?](?:\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd < max) {
    return trimmed.slice(0, sentenceEnd + 1);
  }
  return clip(trimmed, max);
}

/** First non-empty line, clipped */
export function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return clip(line.trim(), max);
}

/** Non-empty lines from text */
export function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
