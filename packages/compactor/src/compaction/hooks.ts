/**
 * Hook integration — session_before_compact + session_compact
 * (parity-aligned with pi-vcc before-compact.ts: token calibration, smart keep,
 * budget-cut rescue, keep:N parsing, invisible auto-continue)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
  SessionEntry,
  SessionMessageEntry,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { compileRanked } from "./summarize.js";
import { loadConfig } from "../config/manager.js";
import {
  buildOwnCut,
  resolveSmartKeepUserTurns,
  applyTailBudget,
  MAX_SMART_TAIL_TOKENS,
} from "./cut.js";
import { parseCompactionInstructions } from "./compact-args.js";
import {
  calibrateCharsPerToken,
  estimateMessageContentChars,
  estimateTokensFromChars,
} from "./token-estimate.js";
import type { CompactionStats } from "../types.js";
import type { SessionDB } from "../session/db.js";

import { COMPACTOR_INSTRUCTION, formatTokens } from "@pi-unipi/core";

let lastStats: CompactionStats | null = null;
let lastCompactWasCompactor = false;
let pendingFollowUpPrompt: string | null = null;
export const getLastCompactionStats = () => lastStats;
export const consumePendingFollowUpPrompt = (): string | null => {
  const p = pendingFollowUpPrompt;
  pendingFollowUpPrompt = null;
  return p;
};

const REASON_MESSAGES: Record<string, string> = {
  no_live_messages: "compactor: Nothing to compact (no live messages)",
  too_few_live_messages: "compactor: Too few messages to compact",
};

const dbg = (debug: boolean, data: Record<string, unknown>) => {
  if (!debug) return;
  try {
    // Lazy import so the debug path never loads node:fs in hot paths.
    import("node:fs").then(({ writeFileSync }) =>
      writeFileSync("/tmp/compactor-debug.json", JSON.stringify(data, null, 2)),
    ).catch(() => {});
  } catch {}
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

/** Format the post-compaction toast (pi-vcc formatCompactionStats parity). */
export const formatCompactionStats = (stats: CompactionStats): string => {
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    return `compactor: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.`;
  }
  const notes: string[] = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) {
    notes.push("smart-keep");
  }
  return `compactor: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
};

/** Count chars in a content part array (legacy helper, kept for stats parity). */
function contentPartsChars(parts: Array<{ text?: string; name?: string; input?: unknown; content?: unknown }>): number {
  return parts.reduce((s: number, p) => {
    if (p.text) return s + p.text.length;
    if (p.name) {
      const inputStr = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
      return s + p.name.length + inputStr.length;
    }
    if (p.content !== undefined) {
      const contentStr = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
      return s + contentStr.length;
    }
    return s;
  }, 0);
}

/** Estimate char count for an AgentMessage (unwrapped — has role + content directly) */
export function messageChars(msg: { content: unknown }): number {
  const c = msg.content;
  if (typeof c === "string") return c.length;
  if (Array.isArray(c)) return contentPartsChars(c as Array<{ text?: string; name?: string; input?: unknown; content?: unknown }>);
  return 0;
}

/** Filter entries to only SessionMessageEntry */
function filterMessageEntries(entries: SessionEntry[]): SessionMessageEntry[] {
  return entries.filter((e): e is SessionMessageEntry => e.type === "message");
}

const readCompactionEventContext = (event: unknown): { reason?: "manual" | "threshold" | "overflow"; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason = raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow"
    ? raw.reason
    : undefined;
  return { reason, willRetry: raw.willRetry === true };
};

export function registerCompactionHooks(
  pi: ExtensionAPI,
  deps?: { getSessionDB?: () => SessionDB | null; getSessionId?: () => string },
): void {
  pi.on("session_before_compact", (event: SessionBeforeCompactEvent, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const config = loadConfig();
    const { isCompactor, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } =
      parseCompactionInstructions(customInstructions);

    // Always handle explicit compactor marker.
    // Otherwise, only handle when user opted in via settings.
    if (!isCompactor && !config.overrideDefaultCompaction) {
      return;
    }

    pendingFollowUpPrompt = null;

    // Calibrate chars/token from Pi's real token count vs actual message chars.
    const calibrationCut = buildOwnCut(branchEntries as any[], 0);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message) => sum + estimateMessageContentChars((message as any).content),
          0,
        )
      : 0;
    const calibrationSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
    );

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: config.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
    });
    let ownCut = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && !keepUserTurnsExplicit) {
      ownCut = applyTailBudget(branchEntries as any[], ownCut, { charsPerToken: tokenEstimate.charsPerToken });
    }
    if (!ownCut.ok) {
      if (!isCompactor && (readCompactionEventContext(event).reason === "overflow")) {
        return; // let pi core retry
      }
      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason] ?? ownCut.reason, "warning");
      } catch {}
      dbg(config.debug, { cancelled: true, reason: ownCut.reason });
      return { cancel: true };
    }

    pendingFollowUpPrompt = followUpPrompt;
    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages as any);

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as SessionEntry[]).findIndex((e: SessionEntry) => e.id === firstKeptEntryId);
    const keptMessageEntries: SessionMessageEntry[] = keptIdx >= 0
      ? filterMessageEntries((branchEntries as SessionEntry[]).slice(keptIdx))
      : [];
    const keptChars = keptMessageEntries.reduce(
      (sum: number, e: SessionMessageEntry) => sum + estimateMessageContentChars((e.message as any)?.content),
      0,
    );

    const tokensBefore = preparation.tokensBefore;
    lastStats = {
      summarized: agentMessages.length,
      kept: keptMessageEntries.length,
      totalMessages: agentMessages.length + keptMessageEntries.length,
      tokensBefore,
      tokensAfterEst: estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken),
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst: estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      smartFromKeep: smartKeep.fromKeep,
      budgetCut: ownCut.budgetCut,
    };

    // Persist cumulative compaction stats
    const sessionDB = deps?.getSessionDB?.();
    if (sessionDB && deps?.getSessionId) {
      try {
        const sessionId = deps.getSessionId();
        const summarizedChars = agentMessages.reduce((sum, msg) => sum + messageChars(msg as any), 0);
        sessionDB.addCompactionStats(sessionId, summarizedChars, keptChars, agentMessages.length);
      } catch {
        // non-fatal
      }
    }

    // Ranked compaction: keep the highest-signal blocks under a token budget
    // instead of the old unranked compile() (fixed 120-line cap). The token
    // budget is converted to a char budget via the session's calibrated
    // charsPerToken so the summary targets ~RANKED_BRIEF_BUDGET_TOKENS tokens
    // regardless of content density. The budget is SIZE-RELATIVE: it scales
    // with transcript length between a floor and a ceiling at
    // RANKED_BRIEF_CHARS_PER_BLOCK per normalized block (pi-vcc parity).
    const RANKED_BRIEF_BUDGET_TOKENS = 1100;
    const RANKED_BRIEF_CEILING_TOKENS = 2000;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    const summary = compileRanked({
      messages: messages as any,
      previousSummary: preparation.previousSummary,
      fileOps: preparation.fileOps
        ? {
            readFiles: [...preparation.fileOps.read],
            modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
          }
        : undefined,
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

    const details = {
      compactor: "@pi-unipi/compactor",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      reason: readCompactionEventContext(event).reason,
      budgetCut: ownCut.budgetCut,
    };

    lastCompactWasCompactor = isCompactor;

    dbg(config.debug, {
      usedOwnCut: true,
      budgetCut: ownCut.budgetCut,
      messagesToSummarize: agentMessages.length,
      firstKeptEntryId,
      tokensBefore,
      tokenEstimate,
      smartKeep,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: details.sections,
    });

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
    if (!event.fromExtension) return;
    if (lastCompactWasCompactor) return; // /unipi:compact handles its own toast
    const stats = lastStats;
    if (!stats) return;
    const { reason } = readCompactionEventContext(event);
    const shouldContinueAfterAutoCompact =
      (reason === "threshold" || reason === "overflow") && loadConfig().continueAfterThresholdCompact;
    setTimeout(() => {
      try {
        ctx?.ui?.notify?.(formatCompactionStats(stats), "info");
      } catch {}
    }, 500);
    if (shouldContinueAfterAutoCompact) {
      // Invisible auto-continue is scheduled by the entry point (index.ts),
      // which owns the pi.sendMessage handle.
    }
  });
}

export { MAX_SMART_TAIL_TOKENS };
