/**
 * Hook integration — session_before_compact + session_compact
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
  SessionEntry,
  SessionMessageEntry,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compile } from "./summarize.js";
import { loadConfig } from "../config/manager.js";
import { buildOwnCut, type OwnCutResult } from "./cut.js";
import type { CompactionStats } from "../types.js";
import type { SessionDB } from "../session/db.js";

import { COMPACTOR_INSTRUCTION, formatTokens } from "@pi-unipi/core";

let lastStats: CompactionStats | null = null;
let lastCompactWasCompactor = false;
export const getLastCompactionStats = () => lastStats;

const REASON_MESSAGES: Record<import("./cut.js").OwnCutCancelReason, string> = {
  no_live_messages: "compactor: Nothing to compact (no live messages)",
  too_few_live_messages: "compactor: Too few messages to compact",
  no_user_message: "compactor: Cannot compact — no user message found",
};

/** Count chars in a content part array (TextContent, ToolCall, ToolResult, etc.) */
function contentPartsChars(parts: Array<{ text?: string; name?: string; input?: unknown; content?: unknown }>): number {
  return parts.reduce((s: number, p) => {
    if (p.text) return s + p.text.length;
    if (p.name) {
      // ToolCall
      const inputStr = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
      return s + p.name.length + inputStr.length;
    }
    if (p.content !== undefined) {
      // ToolResult
      const contentStr = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
      return s + contentStr.length;
    }
    return s;
  }, 0);
}

/** Estimate char count for an AgentMessage (unwrapped — has role + content directly) */
function messageChars(msg: AgentMessage): number {
  const c = (msg as { content: unknown }).content;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return contentPartsChars(c as Array<{ text?: string; name?: string; input?: unknown; content?: unknown }>);
  return 0;
}

/** Estimate char count for a SessionMessageEntry's message */
function entryMessageChars(entry: SessionMessageEntry): number {
  return messageChars(entry.message);
}

/** Filter entries to only SessionMessageEntry */
function filterMessageEntries(entries: SessionEntry[]): SessionMessageEntry[] {
  return entries.filter((e): e is SessionMessageEntry => e.type === "message");
}

export function registerCompactionHooks(
  pi: ExtensionAPI,
  deps?: { getSessionDB?: () => SessionDB | null; getSessionId?: () => string },
): void {
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const config = loadConfig();
    const isCompactor = customInstructions?.startsWith(COMPACTOR_INSTRUCTION) ?? false;

    if (!isCompactor && !config.overrideDefaultCompaction) {
      return;
    }

    const ownCut: OwnCutResult = buildOwnCut(branchEntries);
    if (!ownCut.ok) {
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[(ownCut as { ok: false; reason: import("./cut.js").OwnCutCancelReason }).reason], "warning");
      } catch {}
      return { cancel: true };
    }

    const { messages: agentMessages, firstKeptEntryId } = ownCut;
    const messages = convertToLlm(agentMessages);

    // Find kept entries (from cut point onward)
    const keptIdx = branchEntries.findIndex((e: SessionEntry) => e.id === firstKeptEntryId);
    const keptMessageEntries: SessionMessageEntry[] = keptIdx >= 0
      ? filterMessageEntries(branchEntries.slice(keptIdx))
      : [];

    // Compute char estimates for proportional token estimation
    const summarizedChars = agentMessages.reduce((sum, msg) => sum + messageChars(msg), 0);
    const keptChars = keptMessageEntries.reduce((sum, e) => sum + entryMessageChars(e), 0);
    const totalChars = summarizedChars + keptChars;

    // Use Pi's real token count for "before", estimate "after" proportionally
    const tokensBefore = preparation.tokensBefore;
    const tokensAfterEst = totalChars > 0
      ? Math.round(tokensBefore * keptChars / totalChars)
      : 0;

    lastStats = {
      summarized: agentMessages.length,
      kept: keptMessageEntries.length,
      totalMessages: agentMessages.length + keptMessageEntries.length,
      tokensBefore,
      tokensAfterEst,
    };

    // Persist cumulative compaction stats
    const sessionDB = deps?.getSessionDB?.();
    if (sessionDB && deps?.getSessionId) {
      try {
        const sessionId = deps.getSessionId();
        sessionDB.addCompactionStats(sessionId, summarizedChars, keptChars, agentMessages.length);
      } catch {
        // non-fatal
      }
    }

    const summary = compile({
      messages,
      previousSummary: preparation.previousSummary,
    });

    const details = {
      compactor: "@pi-unipi/compactor",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
    };

    lastCompactWasCompactor = isCompactor;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  pi.on("session_compact", (event: SessionCompactEvent, ctx) => {
    const config = loadConfig();
    if (!event.fromExtension) return;
    if (lastCompactWasCompactor) return;
    const stats = lastStats;
    if (!stats) return;
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(
          `Compacted ${stats.totalMessages} messages (~${formatTokens(stats.tokensBefore)} tokens) → ${stats.kept} messages (~${formatTokens(stats.tokensAfterEst)} tokens)`,
          "info",
        );
      } catch {}
    }, 500);
  });
}
