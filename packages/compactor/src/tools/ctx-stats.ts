/**
 * ctx_stats tool — context savings dashboard
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

  return {
    sessionEvents: sessionStats?.event_count ?? 0,
    compactions: counters?.compactions ?? sessionStats?.compact_count ?? 0,
    tokensSaved: counters?.totalTokensCompacted ?? 0,
    compressionRatio: "N/A",
    indexedDocs: storeStats.sources,
    indexedChunks: storeStats.chunks,
    sandboxRuns: counters?.sandboxRuns ?? 0,
    searchQueries: counters?.searchQueries ?? 0,
  };
}
