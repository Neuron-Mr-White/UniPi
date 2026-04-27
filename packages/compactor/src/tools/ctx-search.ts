/**
 * ctx_search tool — query indexed content
 */

import { ContentStore } from "../store/index.js";
import type { SearchResult } from "../types.js";

export interface CtxSearchInput {
  query: string;
  limit?: number;
  offset?: number;
}

export async function ctxSearch(input: CtxSearchInput): Promise<SearchResult[]> {
  const store = new ContentStore();
  await store.init();
  const results = await store.search(input.query, {
    limit: input.limit ?? 10,
    offset: input.offset ?? 0,
  });
  store.close();
  return results;
}
