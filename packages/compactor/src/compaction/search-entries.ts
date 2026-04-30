/**
 * BM25-lite search over normalized message blocks
 *
 * Includes module-level index cache for fast repeated queries.
 */

import type { NormalizedBlock } from "../types.js";
import { createHash } from "node:crypto";

interface SearchDoc {
  id: number;
  text: string;
  kind: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function buildIndex(docs: SearchDoc[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const doc of docs) {
    const tokens = new Set(tokenize(doc.text));
    for (const t of tokens) {
      const arr = index.get(t) ?? [];
      arr.push(doc.id);
      index.set(t, arr);
    }
  }
  return index;
}

function bm25Score(
  queryTokens: string[],
  docId: number,
  index: Map<string, number[]>,
  docCount: number,
  avgDocLen: number,
  docLens: Map<number, number>,
): number {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;
  const docLen = docLens.get(docId) ?? 1;

  for (const token of queryTokens) {
    const postings = index.get(token) ?? [];
    const df = new Set(postings).size;
    if (df === 0) continue;
    const tf = postings.filter((id) => id === docId).length;
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen))));
  }

  return score;
}

export interface SearchHit {
  docId: number;
  score: number;
  text: string;
  kind: string;
}

// Module-level index cache
let cachedIndexHash = "";
let cachedDocs: SearchDoc[] = [];
let cachedIndex: Map<string, number[]> | null = null;
let cachedDocCount = 0;
let cachedAvgDocLen = 0;
let cachedDocLens: Map<number, number> = new Map();

export function invalidateSearchCache(): void {
  cachedIndexHash = "";
  cachedDocs = [];
  cachedIndex = null;
  cachedDocCount = 0;
  cachedAvgDocLen = 0;
  cachedDocLens = new Map();
}

export function searchEntries(
  blocks: NormalizedBlock[],
  query: string,
  opts?: { limit?: number; offset?: number },
): SearchHit[] {
  const docs: SearchDoc[] = blocks.map((b, i) => ({
    id: i,
    text: b.kind === "tool_call" ? `${b.name} ${JSON.stringify(b.args)}` : b.kind === "tool_result" ? `${b.name} ${b.text}` : b.text,
    kind: b.kind,
  }));

  // Compute content hash to detect blocks change
  const hashSource = docs.length > 0
    ? `${docs.length}:${docs[0].text.slice(0, 80)}:${docs[docs.length - 1].text.slice(-80)}`
    : "empty";
  const currentHash = createHash("sha256").update(hashSource).digest("hex");

  // Use cached index if blocks haven't changed
  let index: Map<string, number[]>;
  let docCount: number;
  let avgDocLen: number;
  let docLens: Map<number, number>;

  if (currentHash === cachedIndexHash && cachedIndex) {
    index = cachedIndex;
    docCount = cachedDocCount;
    avgDocLen = cachedAvgDocLen;
    docLens = cachedDocLens;
  } else {
    index = buildIndex(docs);
    docCount = docs.length;
    docLens = new Map(docs.map((d) => [d.id, tokenize(d.text).length]));
    avgDocLen = docCount > 0 ? [...docLens.values()].reduce((a, b) => a + b, 0) / docCount : 1;

    // Update cache
    cachedIndexHash = currentHash;
    cachedDocs = docs;
    cachedIndex = index;
    cachedDocCount = docCount;
    cachedAvgDocLen = avgDocLen;
    cachedDocLens = docLens;
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const scores = new Map<number, number>();
  for (const doc of docs) {
    const score = bm25Score(queryTokens, doc.id, index, docCount, avgDocLen, docLens);
    if (score > 0) scores.set(doc.id, score);
  }

  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([docId, score]) => {
      const doc = docs[docId];
      return { docId, score, text: doc.text.slice(0, 300), kind: doc.kind };
    });

  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 10;
  return sorted.slice(offset, offset + limit);
}
