/**
 * Info-screen integration for @pi-unipi/compactor
 */

import type { SessionDB } from "./session/db.js";
import type { ContentStore } from "./store/index.js";
import { getLastCompactionStats } from "./compaction/hooks.js";

export interface InfoScreenData {
  sessionEvents: { value: string; detail: string };
  compactions: { value: string; detail: string };
  tokensSaved: { value: string; detail: string };
  compressionRatio: { value: string; detail: string };
  indexedDocs: { value: string; detail: string };
  sandboxExecutions: { value: string; detail: string };
  searchQueries: { value: string; detail: string };
}

export async function getInfoScreenData(
  sessionDB: SessionDB,
  contentStore: ContentStore,
  sessionId: string,
): Promise<InfoScreenData> {
  const stats = sessionDB.getSessionStats(sessionId);
  const compactStats = getLastCompactionStats();
  const storeStats = await contentStore.getStats();

  return {
    sessionEvents: {
      value: String(stats?.event_count ?? 0),
      detail: "Session events tracked",
    },
    compactions: {
      value: String(stats?.compact_count ?? 0),
      detail: compactStats ? `Last: ${compactStats.summarized} msgs` : "No compactions yet",
    },
    tokensSaved: {
      value: compactStats ? `~${compactStats.keptTokensEst}` : "0",
      detail: "Estimated tokens kept",
    },
    compressionRatio: {
      value: compactStats && compactStats.summarized > 0
        ? `${Math.round(compactStats.summarized / Math.max(compactStats.kept, 1))}:1`
        : "N/A",
      detail: "Compression ratio",
    },
    indexedDocs: {
      value: String(storeStats.sources),
      detail: `${storeStats.chunks} chunks indexed`,
    },
    sandboxExecutions: {
      value: "0",
      detail: "Sandbox runs this session",
    },
    searchQueries: {
      value: "0",
      detail: "Search queries this session",
    },
  };
}
