/**
 * Unified search across ContentStore + SessionDB events
 * Supports timeline (chronological) and relevance sorting
 * (from context-mode src/search/unified.ts)
 */

import type { ContentStore } from "./index.js";
import type { SessionDB } from "../session/db.js";
import type { SearchResult } from "../types.js";

export interface UnifiedSearchResult {
  title: string;
  content: string;
  source: string;
  origin: "current-session" | "prior-session";
  timestamp: string;
  rank: number;
  matchLayer: string;
  contentType: "prose" | "code";
}

export interface UnifiedSearchOptions {
  query: string;
  limit?: number;
  sort?: "relevance" | "timeline";
  source?: string;
  contentType?: string;
  projectDir?: string;
}

/**
 * Search across multiple sources and optionally sort chronologically.
 * - relevance: ContentStore only, ranked by RRF
 * - timeline: ContentStore + SessionDB events, sorted by timestamp
 */
export async function searchAllSources(
  store: ContentStore,
  sessionDB: SessionDB | null,
  opts: UnifiedSearchOptions,
): Promise<UnifiedSearchResult[]> {
  const limit = opts.limit ?? 10;
  const sort = opts.sort ?? "relevance";
  const sessionStartTime = new Date().toISOString();

  const results: UnifiedSearchResult[] = [];

  // Source 1: ContentStore (always, both modes)
  try {
    const storeResults = await store.search(opts.query, { limit });
    results.push(
      ...storeResults.map((r) => ({
        title: r.title,
        content: r.content,
        source: r.source,
        origin: "current-session" as const,
        timestamp: sessionStartTime, // ContentStore doesn't track per-result timestamps yet
        rank: r.rank,
        matchLayer: r.matchLayer ?? "porter",
        contentType: r.contentType,
      })),
    );
  } catch {
    // ContentStore search failed — continue with other sources
  }

  // Source 2: SessionDB events (timeline mode only)
  if (sort === "timeline" && sessionDB) {
    try {
      const sessionId = opts.projectDir ?? "";
      const events = sessionDB.getEvents(sessionId, { limit: 100 });
      const queryLower = opts.query.toLowerCase();
      const matchingEvents = events.filter((e) => {
        const data = String(e.data ?? "").toLowerCase();
        const type = String(e.type ?? "").toLowerCase();
        const category = String(e.category ?? "").toLowerCase();
        return data.includes(queryLower) || type.includes(queryLower) || category.includes(queryLower);
      });

      results.push(
        ...matchingEvents.slice(0, limit).map((e) => ({
          title: `[${e.category}] ${e.type}`,
          content: String(e.data ?? "").slice(0, 500),
          source: "prior-session",
          origin: "prior-session" as const,
          timestamp: e.created_at ?? sessionStartTime,
          rank: 0,
          matchLayer: "event",
          contentType: "prose" as const,
        })),
      );
    } catch {
      // SessionDB search failed — continue
    }
  }

  // Normalize SQLite datetime format to ISO 8601
  for (const r of results) {
    if (r.timestamp && !r.timestamp.includes("T")) {
      r.timestamp = r.timestamp.replace(" ", "T") + "Z";
    }
  }

  // Sort: timeline = chronological, relevance = by rank
  if (sort === "timeline") {
    results.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  }

  return results.slice(0, limit);
}
