/**
 * BM25-lite search over normalized message blocks
 */

import type { NormalizedBlock } from "../types.js";

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

  const index = buildIndex(docs);
  const docCount = docs.length;
  const docLens = new Map(docs.map((d) => [d.id, tokenize(d.text).length]));
  const avgDocLen = docCount > 0 ? [...docLens.values()].reduce((a, b) => a + b, 0) / docCount : 1;

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
