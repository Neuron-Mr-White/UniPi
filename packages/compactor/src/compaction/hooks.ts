/**
 * Hook integration — session_before_compact + session_compact
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { compile } from "./summarize.js";
import { loadConfig } from "../config/manager.js";
import { buildOwnCut } from "./cut.js";
import type { CompactionStats } from "../types.js";
import type { SessionDB } from "../session/db.js";

export const COMPACTOR_INSTRUCTION = "__compactor__";

let lastStats: CompactionStats | null = null;
let lastCompactWasCompactor = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const dbg = (debug: boolean, event: string, data?: Record<string, unknown>) => {
  if (!debug) return;
  const ts = new Date().toISOString().slice(11, 23);
  const details = data ? " " + JSON.stringify(data) : "";
  console.error(`[compactor:${ts}] ${event}${details}`);
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

const REASON_MESSAGES: Record<import("./cut.js").OwnCutCancelReason, string> = {
  no_live_messages: "compactor: Nothing to compact (no live messages)",
  too_few_live_messages: "compactor: Too few messages to compact",
  no_user_message: "compactor: Cannot compact — no user message found",
};

export function registerCompactionHooks(
  pi: ExtensionAPI,
  deps?: { getSessionDB?: () => SessionDB | null; getSessionId?: () => string },
): void {
  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const config = loadConfig();
    dbg(config.debug, "session_before_compact:enter", { entryCount: (branchEntries as any[])?.length, hasPrevSummary: !!preparation?.previousSummary, isCompactor: customInstructions === COMPACTOR_INSTRUCTION });

    const isCompactor = customInstructions === COMPACTOR_INSTRUCTION;
    if (!isCompactor && !config.overrideDefaultCompaction) {
      dbg(config.debug, "session_before_compact:skip", { reason: "not_compactor_and_no_override" });
      return;
    }

    const ownCut = buildOwnCut(branchEntries as any[]);
    dbg(config.debug, "buildOwnCut", { ok: ownCut.ok, reason: !ownCut.ok ? (ownCut as any).reason : undefined });
    if (!ownCut.ok) {
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce((sum: number, e: any) => {
      const c = e.message?.content;
      if (typeof c === "string") return sum + c.length;
      if (Array.isArray(c)) return sum + c.reduce((s: number, p: any) => {
        if (p.text) return s + p.text.length;
        if (p.type === "toolCall") return s + (p.name?.length ?? 0) + (typeof p.input === "string" ? p.input.length : JSON.stringify(p.input ?? "").length);
        if (p.type === "toolResult") return s + (typeof p.content === "string" ? p.content.length : JSON.stringify(p.content ?? "").length);
        return s;
      }, 0);
      return sum;
    }, 0);
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptTokensEst: Math.round(keptChars / 4),
    };

    // Persist cumulative compaction stats
    const sessionDB = deps?.getSessionDB?.();
    if (sessionDB && deps?.getSessionId) {
      try {
        const sessionId = deps.getSessionId();
        const charsBefore = agentMessages.reduce((sum: number, msg: any) => {
          const c = msg.message?.content;
          if (typeof c === "string") return sum + c.length;
          if (Array.isArray(c)) return sum + c.reduce((s: number, p: any) => s + (p.text?.length ?? 0), 0);
          return sum;
        }, 0);
        sessionDB.addCompactionStats(sessionId, charsBefore, keptChars, agentMessages.length);
      } catch {
        // non-fatal
      }
    }

    dbg(config.debug, "compile", { messageCount: messages.length, hasPrevSummary: !!preparation.previousSummary });
    const summary = compile({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    });

    dbg(config.debug, "compaction_pipeline", {
      usedOwnCut: true,
      messagesToSummarize: agentMessages.length,
      firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      summaryLength: summary.length,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
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

  pi.on("session_compact", (event, ctx) => {
    const config = loadConfig();
    dbg(config.debug, "session_compact", { fromExtension: event.fromExtension, lastCompactWasCompactor });
    if (!event.fromExtension) return;
    if (lastCompactWasCompactor) return;
    const stats = lastStats;
    if (!stats) return;
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(
          `compactor: ${stats.summarized} source entries processed; tail kept ${stats.kept} (~${formatTokens(stats.keptTokensEst)} tok).`,
          "info",
        );
      } catch {}
    }, 500);
  });
}
