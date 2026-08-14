/**
 * vcc_recall tool — BM25-lite session history search
 */

import type { NormalizedBlock } from "../types.js";
import { searchEntries } from "../compaction/search-entries.js";

export const MAX_RECALL_RESULTS = 50;
export const MAX_EXPANDED_HIT_BYTES = 16 * 1024;

export interface RecallInput {
  query: string;
  mode?: "bm25" | "regex";
  limit?: number;
  offset?: number;
  expand?: boolean;
}

function truncateExpandedHit(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_EXPANDED_HIT_BYTES) return text;
  const omitted = bytes.byteLength - MAX_EXPANDED_HIT_BYTES;
  const visible = bytes.subarray(0, MAX_EXPANDED_HIT_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${visible}\n… ${omitted} bytes omitted from this hit; narrow the query to inspect more specific context …`;
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
  const { query, mode = "bm25", expand = false } = input;
  const requestedLimit = Number.isFinite(input.limit) ? Math.floor(input.limit!) : 10;
  const requestedOffset = Number.isFinite(input.offset) ? Math.floor(input.offset!) : 0;
  const limit = Math.min(MAX_RECALL_RESULTS, Math.max(1, requestedLimit));
  const offset = Math.max(0, requestedOffset);

  let hits: Array<{ index: number; score: number; text: string; kind: string }> = [];

  if (mode === "bm25") {
    const results = searchEntries(blocks, query, { limit: limit + offset, offset: 0 });
    hits = results.map((r, i) => ({
      index: r.docId,
      score: r.score,
      text: expand ? truncateExpandedHit(r.text) : r.text.slice(0, 200),
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
          text: expand ? truncateExpandedHit(text) : text.slice(0, 200),
          kind: b.kind,
        });
      }
    }
  }

  const total = hits.length;
  const paginated = hits.slice(offset, offset + limit);

  return { hits: paginated, total, query };
}
