/**
 * vcc_recall tool — BM25-lite session history search
 */

import type { NormalizedBlock } from "../types.js";
import { searchEntries } from "../compaction/search-entries.js";

export interface RecallInput {
  query: string;
  mode?: "bm25" | "regex";
  limit?: number;
  offset?: number;
  expand?: boolean;
}

export interface RecallResult {
  hits: Array<{
    index: number;
    score: number;
    text: string;
    kind: string;
  }>;
  total: number;
  query: string;
}

export function vccRecall(
  blocks: NormalizedBlock[],
  input: RecallInput,
): RecallResult {
  const { query, mode = "bm25", limit = 10, offset = 0, expand = false } = input;

  let hits: Array<{ index: number; score: number; text: string; kind: string }> = [];

  if (mode === "bm25") {
    const results = searchEntries(blocks, query, { limit: limit + offset, offset: 0 });
    hits = results.map((r, i) => ({
      index: r.docId,
      score: r.score,
      text: expand ? r.text : r.text.slice(0, 200),
      kind: r.kind,
    }));
  } else {
    // Regex fallback
    const re = new RegExp(query, "i");
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const text = b.kind === "tool_call" ? `${b.name} ${JSON.stringify(b.args)}` : b.kind === "tool_result" ? `${b.name} ${b.text}` : b.text;
      if (re.test(text)) {
        hits.push({
          index: i,
          score: 1,
          text: expand ? text : text.slice(0, 200),
          kind: b.kind,
        });
      }
    }
  }

  const total = hits.length;
  const paginated = hits.slice(offset, offset + limit);

  return { hits: paginated, total, query };
}
