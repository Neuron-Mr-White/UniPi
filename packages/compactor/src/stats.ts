/**
 * Compaction stats read straight from the session branch — no database.
 *
 * tokensAfter comes from our own compaction details when present; otherwise
 * (Pi's summaries, older entries) it is estimated as summary + kept tail.
 */

import { estimateMessageContentChars } from "./compaction/token-estimate.js";

export interface CompactionRecord {
  tokensBefore: number;
  tokensAfter: number;
  method: "vcc" | "llm";
}

export interface SessionCompactionStats {
  compactions: CompactionRecord[];
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
  toolCalls: Map<string, number>;
  totalToolCalls: number;
}

const CHARS_PER_TOKEN = 4;

export function sessionCompactionStats(branch: readonly any[]): SessionCompactionStats {
  const compactions: CompactionRecord[] = [];
  const toolCalls = new Map<string, number>();
  let totalToolCalls = 0;

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry?.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const part of entry.message.content) {
        if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
        toolCalls.set(part.name, (toolCalls.get(part.name) ?? 0) + 1);
        totalToolCalls++;
      }
      continue;
    }
    if (entry?.type !== "compaction") continue;
    const before = Number(entry.tokensBefore ?? 0);
    const details = entry.details ?? {};
    let after = Number(details.tokensAfter ?? 0);
    if (!after) {
      const keptIdx = entry.firstKeptEntryId ? branch.findIndex((e) => e?.id === entry.firstKeptEntryId) : -1;
      let chars = typeof entry.summary === "string" ? entry.summary.length : 0;
      if (keptIdx >= 0 && keptIdx < i) {
        for (let k = keptIdx; k < i; k++) {
          if (branch[k]?.type === "message") chars += estimateMessageContentChars(branch[k].message?.content);
        }
      }
      after = Math.ceil(chars / CHARS_PER_TOKEN);
    }
    compactions.push({
      tokensBefore: before,
      tokensAfter: after,
      method: details.compactor === "@pi-unipi/compactor" && details.method !== "llm" ? "vcc" : "llm",
    });
  }

  const tokensBefore = compactions.reduce((s, c) => s + c.tokensBefore, 0);
  const tokensAfter = compactions.reduce((s, c) => s + Math.min(c.tokensAfter, c.tokensBefore || c.tokensAfter), 0);
  return {
    compactions,
    tokensBefore,
    tokensAfter,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    toolCalls,
    totalToolCalls,
  };
}
