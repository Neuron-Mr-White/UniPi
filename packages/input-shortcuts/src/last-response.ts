/**
 * The text of the LAST assistant response — what pi's own `/copy` copies
 * (see `getLastAssistantText` in pi's agent-session), mirrored through the
 * extension API: `ctx.sessionManager.getBranch()` entries, newest last.
 *
 * Thinking blocks and tool calls are skipped, aborted messages with no
 * content are skipped, and an assistant message whose text is empty does not
 * stop the search — the latest response WITH text wins.
 */

/** Structural subset of a session entry (pi SessionEntry) — testable. */
export interface SessionEntryLike {
  type?: string;
  message?: {
    role?: string;
    stopReason?: string;
    content?: Array<{ type: string; text?: string }>;
  };
}

export function getLastResponseText(entries: readonly SessionEntryLike[] | undefined): string | undefined {
  if (!entries) return undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    // Mirror pi: an aborted message with no content is not a response.
    if (message.stopReason === "aborted" && (message.content?.length ?? 0) === 0) continue;
    let text = "";
    for (const block of message.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    text = text.trim();
    if (text) return text;
  }
  return undefined;
}
