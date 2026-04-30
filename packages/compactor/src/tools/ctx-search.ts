/**
 * ctx_search tool — query indexed content
 */

import type { ContentStore } from "../store/index.js";
import type { SearchResult } from "../types.js";

export interface CtxSearchInput {
  query: string;
  limit?: number;
  offset?: number;
}

export async function ctxSearch(store: ContentStore, input: CtxSearchInput): Promise<SearchResult[]> {
  return store.search(input.query, {
    limit: input.limit ?? 10,
    offset: input.offset ?? 0,
  });
}
