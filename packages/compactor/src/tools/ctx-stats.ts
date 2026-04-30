/**
 * ctx_stats tool — context savings dashboard
 */

import type { SessionDB } from "../session/db.js";
import type { ContentStore } from "../store/index.js";

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
): Promise<CtxStatsResult> {
  const sessionStats = sessionDB.getSessionStats(sessionId);
  const storeStats = await contentStore.getStats();
  const allTime = sessionDB.getAllTimeStats();

  // Token estimation: ~4 chars per token
  const tokensCompacted = Math.round((allTime.allCharsBefore - allTime.allCharsKept) / 4);
  const compressionRatio = allTime.allCharsKept > 0
    ? `${Math.round(allTime.allCharsBefore / allTime.allCharsKept)}:1`
    : "N/A";

  return {
    sessionEvents: sessionStats?.event_count ?? 0,
    compactions: sessionStats?.compact_count ?? 0,
    tokensSaved: tokensCompacted,
    compressionRatio,
    indexedDocs: storeStats.sources,
    indexedChunks: storeStats.chunks,
    sandboxRuns: 0,
    searchQueries: 0,
  };
}
