/**
 * Compaction stats read straight from the session branch — no database.
 *
 * tokensAfter comes from our own compaction details when present; otherwise
 * (Pi's summaries, older entries) it is estimated as summary + kept tail.
 */

import { estimateMessageContentChars } from "./compaction/token-estimate.js";
import type { CompactionMethod } from "./types.js";

export interface CompactionRecord {
  tokensBefore: number;
  tokensAfter: number;
  method: CompactionMethod;
  /** Epoch ms, when the entry records it. */
  at?: number;
  /** Items jev dropped (jev method only). */
  jevDropped?: number;
}

export interface SessionCompactionStats {
  compactions: CompactionRecord[];
  tokensSaved: number;
  tokensBefore: number;
  tokensAfter: number;
}

const CHARS_PER_TOKEN = 4;

function methodOf(details: any): CompactionMethod {
  if (details?.compactor !== "@pi-unipi/compactor") return "llm";
  return details.method === "llm" || details.method === "jev" ? details.method : "vcc";
}

export function sessionCompactionStats(branch: readonly any[]): SessionCompactionStats {
  const compactions: CompactionRecord[] = [];
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
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
    const at = Date.parse(entry.timestamp ?? "");
    const method = methodOf(details);
    compactions.push({
      tokensBefore: before,
      tokensAfter: after,
      method,
      ...(Number.isFinite(at) ? { at } : {}),
      ...(method === "jev" && typeof details.jev?.dropped === "number" ? { jevDropped: details.jev.dropped } : {}),
    });
  }

  const tokensBefore = compactions.reduce((s, c) => s + c.tokensBefore, 0);
  const tokensAfter = compactions.reduce((s, c) => s + Math.min(c.tokensAfter, c.tokensBefore || c.tokensAfter), 0);
  return { compactions, tokensBefore, tokensAfter, tokensSaved: Math.max(0, tokensBefore - tokensAfter) };
}

const METHOD_WORD: Record<CompactionMethod, string> = { vcc: "lossless", jev: "jev", llm: "model" };

/** "3 lossless, 1 jev" — only the methods that occurred. */
export function methodBreakdown(stats: SessionCompactionStats): string {
  const counts = new Map<CompactionMethod, number>();
  for (const c of stats.compactions) counts.set(c.method, (counts.get(c.method) ?? 0) + 1);
  return [...counts.entries()].map(([m, n]) => `${n} ${METHOD_WORD[m]}`).join(", ");
}
