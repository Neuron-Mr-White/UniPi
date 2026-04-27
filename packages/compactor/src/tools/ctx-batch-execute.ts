/**
 * ctx_batch_execute tool — atomic batch of commands + searches
 */

import { PolyglotExecutor } from "../executor/executor.js";
import { ContentStore } from "../store/index.js";
import type { Language, ExecResult, SearchResult } from "../types.js";

export interface BatchCommand {
  type: "execute";
  language: Language;
  code: string;
  timeout?: number;
}

export interface BatchSearch {
  type: "search";
  query: string;
  limit?: number;
}

export type BatchItem = BatchCommand | BatchSearch;

export interface BatchResult {
  results: Array<
    | { type: "execute"; result: ExecResult }
    | { type: "search"; results: SearchResult[] }
  >;
}

export async function ctxBatchExecute(items: BatchItem[]): Promise<BatchResult> {
  const results: BatchResult["results"] = [];
  const executor = new PolyglotExecutor();
  const store = new ContentStore();
  await store.init();

  for (const item of items) {
    if (item.type === "execute") {
      const result = await executor.execute({
        language: item.language,
        code: item.code,
        timeout: item.timeout ?? 30000,
      });
      results.push({ type: "execute", result });
    } else {
      const searchResults = await store.search(item.query, { limit: item.limit ?? 10 });
      results.push({ type: "search", results: searchResults });
    }
  }

  store.close();
  return { results };
}
