/**
 * ctx_search tool — query indexed content
 * With progressive throttling (matching context-mode behavior)
 */

import { ContentStore } from "../store/index.js";
import { searchAllSources } from "../store/unified.js";
import type { SearchResult } from "../types.js";
import { SessionDB } from "../session/db.js";
import { loadConfig } from "../config/manager.js";

export interface CtxSearchInput {
  query: string;
  limit?: number;
  offset?: number;
  mode?: "porter" | "trigram" | "rrf" | "fuzzy";
  sort?: "relevance" | "timeline";
  projectDir?: string;
}

/** Progressive throttling state */
interface ThrottleState {
  callCount: number;
  windowStart: number;
}

const throttleState: ThrottleState = {
  callCount: 0,
  windowStart: Date.now(),
};

/** 60-second throttle window */
const THROTTLE_WINDOW_MS = 60_000;

/** After 3 calls: reduce results */
const THROTTLE_REDUCE_AFTER = 3;

/** After 8 calls: block entirely */
const THROTTLE_BLOCK_AFTER = 8;

export interface ThrottledSearchResult {
  results: SearchResult[];
  throttled: boolean;
  blocked: boolean;
  warning?: string;
  callCount: number;
}

export async function ctxSearch(input: CtxSearchInput): Promise<ThrottledSearchResult> {
  const config = loadConfig();

  // Progressive throttling: track calls in time window (if enabled)
  if (config.pipeline.progressiveThrottling) {
    const now = Date.now();
    if (now - throttleState.windowStart > THROTTLE_WINDOW_MS) {
      throttleState.callCount = 0;
      throttleState.windowStart = now;
    }
    throttleState.callCount++;

    // Block tier: refuse if too many calls
    if (throttleState.callCount > THROTTLE_BLOCK_AFTER) {
      const elapsed = Math.round((now - throttleState.windowStart) / 1000);
      return {
        results: [],
        throttled: true,
        blocked: true,
        warning: `BLOCKED: ${throttleState.callCount} search calls in ${elapsed}s. You're flooding context. STOP making individual search calls. Use ctx_batch_execute(commands, queries) for your next research step.`,
        callCount: throttleState.callCount,
      };
    }
  }

  const store = new ContentStore();
  await store.init();

  try {
    // Reduced tier: limit to 1 result per query (if throttling enabled)
    const isReduced = config.pipeline.progressiveThrottling && throttleState.callCount > THROTTLE_REDUCE_AFTER;
    const effectiveLimit = isReduced ? 1 : Math.min(input.limit ?? 10, 2);

    // Timeline mode: unified search across ContentStore + SessionDB
    if (input.sort === "timeline" && config.pipeline.timelineSort) {
      const sessionDB = new SessionDB();
      await sessionDB.init();
      try {
        const unifiedResults = await searchAllSources(store, sessionDB, {
          query: input.query,
          limit: effectiveLimit,
          sort: "timeline",
          projectDir: input.projectDir,
        });
        const mappedResults: SearchResult[] = unifiedResults.map((r) => ({
          title: r.title,
          content: r.content,
          source: r.source,
          rank: r.rank,
          contentType: r.contentType,
          matchLayer: r.matchLayer as any,
        }));
        return {
          results: mappedResults,
          throttled: isReduced,
          blocked: false,
          warning: isReduced ? `⚠ search call #${throttleState.callCount}/${THROTTLE_BLOCK_AFTER}. Results limited to ${effectiveLimit}/query. Batch queries or use ctx_batch_execute.` : undefined,
          callCount: throttleState.callCount,
        };
      } finally {
        sessionDB.close();
      }
    }

    // Relevance mode: standard search
    const results = await store.search(input.query, {
      limit: effectiveLimit,
      offset: input.offset ?? 0,
      mode: input.mode,
    });

    let warning: string | undefined;
    if (isReduced) {
      warning = `⚠ search call #${throttleState.callCount}/${THROTTLE_BLOCK_AFTER} in this window. Results limited to ${effectiveLimit}/query. Batch queries: ctx_search(queries: ["q1","q2","q3"]) or use ctx_batch_execute.`;
    }

    return {
      results,
      throttled: isReduced,
      blocked: false,
      warning,
      callCount: throttleState.callCount,
    };
  } finally {
    store.close();
  }
}
