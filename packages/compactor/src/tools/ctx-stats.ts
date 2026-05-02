/**
 * ctx_stats tool — context savings dashboard
 *
 * Stats driven by compaction savings (DB-first) with runtime counter fallback.
 */

import type { SessionDB } from "../session/db.js";
import type { ContentStore } from "../store/index.js";
import type { RuntimeCounters } from "../types.js";

export interface CtxStatsResult {
  sessionEvents: number;
  compactions: number;
  tokensSaved: number;
  compressionRatio: string;
  indexedDocs: number;
  indexedChunks: number;
  sandboxRuns: number;
  searchQueries: number;
}

export async function ctxStats(
  sessionDB: SessionDB,
  contentStore: ContentStore,
  sessionId: string,
  counters?: RuntimeCounters,
): Promise<CtxStatsResult> {
  const sessionStats = sessionDB.getSessionStats(sessionId);
  const storeStats = await contentStore.getStats();

  // Compute tokensSaved: prefer in-memory counters (current session),
  // fall back to per-session DB stats, then all-time DB stats.
  let tokensSaved = counters?.totalTokensCompacted ?? 0;
  if (tokensSaved === 0 && sessionStats) {
    const sessionCharsBefore = (sessionStats as any).total_chars_before ?? 0;
    const sessionCharsKept = (sessionStats as any).total_chars_kept ?? 0;
    tokensSaved = Math.round((sessionCharsBefore - sessionCharsKept) / 4);
  }
  if (tokensSaved === 0) {
    const allTime = sessionDB.getAllTimeStats();
    tokensSaved = Math.round((allTime.allCharsBefore - allTime.allCharsKept) / 4);
  }

  // Compute compactions: prefer in-memory counter (current session),
  // fall back to per-session DB, then all-time DB.
  let compactions = counters?.compactions ?? 0;
  if (compactions === 0) {
    compactions = sessionStats?.compact_count ?? 0;
  }
  if (compactions === 0) {
    const allTime = sessionDB.getAllTimeStats();
    compactions = allTime.allCompactions;
  }

  // Compression ratio
  let ratio = "N/A";
  if (sessionStats) {
    const before = (sessionStats as any).total_chars_before ?? 0;
    const kept = (sessionStats as any).total_chars_kept ?? 0;
    if (before > 0 && kept > 0) {
      ratio = `${(before / kept).toFixed(1)}:1`;
    }
  }

  return {
    sessionEvents: sessionStats?.event_count ?? 0,
    compactions,
    tokensSaved,
    compressionRatio: ratio,
    indexedDocs: storeStats.sources,
    indexedChunks: storeStats.chunks,
    sandboxRuns: counters?.sandboxRuns ?? 0,
    searchQueries: counters?.searchQueries ?? 0,
  };
}
