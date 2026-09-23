/** Extract readable text from a tool's partial result (AgentToolResult shape). */
export function extractText(partialResult: unknown): string {
  if (partialResult === null || partialResult === undefined) return "";
  if (typeof partialResult === "string") return partialResult;
  try {
    const record = partialResult as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(record.content)) {
      return record.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => (c.text as string).replace(/\n$/, ""))
        .join("\n");
    }
  } catch {
    // Fall through
  }
  return "";
}
