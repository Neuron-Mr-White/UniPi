/**
 * Build searchable recall blocks from Pi session entries.
 *
 * `ctx.messages` is not available to command handlers and compacted session
 * context only contains summaries/kept messages. The append-only session branch
 * still contains the raw pre-compaction messages, so recall should index that
 * branch directly.
 */

import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeMessages } from "../compaction/normalize.js";
import { sanitize } from "../compaction/sanitize.js";
import { textOf } from "../compaction/content.js";
import type { NormalizedBlock } from "../types.js";

function block(kind: "user" | "assistant", text: string, sourceIndex?: number): NormalizedBlock[] {
  const clean = sanitize(text);
  return clean ? [{ kind, text: clean, sourceIndex }] : [];
}

function normalizeAgentMessage(message: AgentMessage, sourceIndex: number): NormalizedBlock[] {
  const role = (message as { role?: string }).role;

  // Standard LLM message roles are handled by the existing normalizer.
  if (role === "user" || role === "assistant" || role === "toolResult") {
    return normalizeMessages([message as Parameters<typeof normalizeMessages>[0][number]]).map((b) => ({
      ...b,
      sourceIndex,
    }));
  }

  // Pi-specific session message roles that do not participate in pi-ai Message.
  if (role === "bashExecution") {
    const msg = message as AgentMessage & {
      command?: string;
      output?: string;
      exitCode?: number;
      cancelled?: boolean;
    };
    const text = [`$ ${msg.command ?? ""}`, msg.output ?? ""].filter(Boolean).join("\n");
    return text
      ? [{ kind: "tool_result", name: "bash", text: sanitize(text), isError: Boolean(msg.cancelled || (msg.exitCode ?? 0) !== 0), sourceIndex }]
      : [];
  }

  if (role === "custom") {
    const msg = message as AgentMessage & { customType?: string; content?: unknown };
    return block("user", [msg.customType, textOf(msg.content)].filter(Boolean).join("\n"), sourceIndex);
  }

  if (role === "branchSummary") {
    const msg = message as AgentMessage & { summary?: string };
    return block("assistant", msg.summary ?? "", sourceIndex);
  }

  if (role === "compactionSummary") {
    const msg = message as AgentMessage & { summary?: string };
    return block("assistant", msg.summary ?? "", sourceIndex);
  }

  return [];
}

/** Convert the active append-only session branch into searchable blocks. */
export function recallBlocksFromSessionEntries(entries: SessionEntry[]): NormalizedBlock[] {
  return entries.flatMap((entry, i) => {
    if (entry.type === "message") {
      return normalizeAgentMessage(entry.message, i);
    }

    if (entry.type === "custom_message") {
      return block("user", [entry.customType, textOf(entry.content)].filter(Boolean).join("\n"), i);
    }

    if (entry.type === "branch_summary") {
      return block("assistant", entry.summary, i);
    }

    if (entry.type === "compaction") {
      return block("assistant", entry.summary, i);
    }

    return [];
  });
}

/** Best-effort read of searchable blocks from an extension context. */
export function recallBlocksFromContext(ctx: unknown): NormalizedBlock[] {
  const sessionManager = (ctx as { sessionManager?: { getBranch?: () => SessionEntry[]; buildSessionContext?: () => { messages?: AgentMessage[] } } })?.sessionManager;

  try {
    const entries = sessionManager?.getBranch?.();
    if (Array.isArray(entries) && entries.length > 0) {
      const blocks = recallBlocksFromSessionEntries(entries);
      if (blocks.length > 0) return blocks;
    }
  } catch {
    // Fall through to compacted context fallback.
  }

  try {
    const messages = sessionManager?.buildSessionContext?.().messages ?? [];
    if (messages.length > 0) {
      return messages.flatMap((message, i) => normalizeAgentMessage(message, i));
    }
  } catch {
    // No session context available.
  }

  return [];
}
