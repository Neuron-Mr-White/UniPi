/**
 * Hook integration — session_before_compact + session_compact
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { compile } from "./summarize.js";
import { loadConfig } from "../config/manager.js";
import { buildOwnCut } from "./cut.js";
import type { CompactionStats } from "../types.js";

export const COMPACTOR_INSTRUCTION = "__compactor__";

let lastStats: CompactionStats | null = null;
let lastCompactWasCompactor = false;
export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

const dbg = (debug: boolean, data: Record<string, unknown>) => {
  if (!debug) return;
  try { writeFileSync("/tmp/compactor-debug.json", JSON.stringify(data, null, 2)); } catch {}
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

export function registerCompactionHooks(pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const config = loadConfig();

    const isCompactor = customInstructions === COMPACTOR_INSTRUCTION;
    if (!isCompactor && !config.overrideDefaultCompaction) return;

    const ownCut = buildOwnCut(branchEntries as any[]);
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

    const summary = compile({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
    });

    dbg(config.debug, {
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
