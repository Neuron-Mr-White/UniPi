/**
 * Hybrid search over normalized message blocks (pi-vcc parity):
 * regex-pattern detection with keyword BM25 fallback, line snippets,
 * and match-count ranking. Includes module-level index cache.
 */

import type { NormalizedBlock } from "../types.js";
import { extractPath } from "./extract/files.js";
import { createHash } from "node:crypto";

export interface SearchHit {
  docId: number;
  score: number;
  text: string;
  kind: string;
}

/** Recall hit with optional snippet + file indicators (format-recall shape) */
export interface RecallHit {
  index: number;
  score: number;
  text: string;
  kind: string;
  snippet?: string;
  matchCount?: number;
  files?: string[];
}

interface SearchDoc {
  id: number;
  text: string;
  kind: string;
  files: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

// ── Regex safety (pi-vcc parity) ──────────────────────────────────────────

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quantifier starting at `i`, if any. Only unbounded forms (+, *, {n,}) can
 *  drive catastrophic backtracking. */
const quantifierAt = (p: string, i: number): { len: number; unbounded: boolean } => {
  const c = p[i];
  if (c === "+" || c === "*") return { len: 1, unbounded: true };
  if (c === "{") {
    const end = p.indexOf("}", i);
    const body = end === -1 ? "" : p.slice(i + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { len: end - i + 1, unbounded: body.endsWith(",") };
  }
  return { len: 0, unbounded: false };
};

/**
 * Detect an unbounded quantifier applied to a group that already contains one,
 * e.g. `(a+)+`. The search budget in `searchEntries` is the backstop.
 */
const hasNestedQuantifier = (pattern: string): boolean => {
  const groups: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { groups.push(false); continue; }
    if (c === ")") {
      const inner = groups.pop() ?? false;
      const q = quantifierAt(pattern, i + 1);
      if (inner && q.unbounded) return true;
      if (groups.length) groups[groups.length - 1] ||= inner || q.unbounded;
      i += q.len;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q.unbounded && groups.length) {
      groups[groups.length - 1] = true;
      i += q.len - 1;
    }
  }
  return false;
};

/** Try to compile as regex; fall back to escaped literal. Patterns with nested
 *  unbounded quantifiers are treated as literals rather than compiled. */
const safeRegex = (pattern: string): RegExp => {
  if (hasNestedQuantifier(pattern)) return new RegExp(escapeRegex(pattern), "i");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/** Wall-clock budget for one search. Per-entry checkpoint, not a hard ceiling. */
const SEARCH_BUDGET_MS = 3000;

const startBudget = (): (() => void) => {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms. Simplify the pattern — ` +
        "nested quantifiers such as (a+)+ can make matching blow up.",
      );
    }
  };
};

/** Detect if the query looks like a single regex pattern (contains metacharacters). */
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);

/** Build a regex for snippet highlighting — matches first available term. */
const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => safeRegex(t).source);
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  return meaningful.length > 0 ? meaningful : terms;
};

const countMatches = (hay: string, terms: string[]): number => {
  let count = 0;
  for (const t of terms) {
    if (safeRegex(t).test(hay)) count++;
  }
  return count;
};

// ── BM25 scoring ──────────────────────────────────────────────────────────
const BM25_K = 1.2;
const BM25_B = 0.75;

const termFreq = (text: string, pattern: RegExp): number => {
  const matches = text.match(new RegExp(pattern.source, "gi"));
  return matches ? matches.length : 0;
};

interface BM25Context {
  n: number;
  avgDl: number;
  df: Map<string, number>;
}

const buildBM25Context = (docs: string[], terms: string[], checkBudget: () => void): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    checkBudget();
    totalLen += doc.split(/\s+/).length;
    for (const t of terms) {
      if (safeRegex(t).test(doc)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

const bm25Score = (doc: string, terms: string[], ctx: BM25Context): number => {
  const dl = doc.split(/\s+/).length;
  let score = 0;

  for (const t of terms) {
    const tf = termFreq(doc, safeRegex(t));
    if (tf === 0) continue;

    const docFreq = ctx.df.get(t) ?? 0;
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end);

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

// ── Block → doc text ──────────────────────────────────────────────────────

const blockFiles = (b: NormalizedBlock): string[] => {
  if (b.kind !== "tool_call") return [];
  const p = extractPath(b.args);
  return p ? [p] : [];
};

const blockText = (b: NormalizedBlock): string =>
  b.kind === "tool_call" ? `${b.name} ${JSON.stringify(b.args)}` : b.kind === "tool_result" ? `${b.name} ${b.text}` : b.text;

// ── Module-level index cache ──────────────────────────────────────────────

let cachedIndexHash = "";
let cachedIndex: Map<string, number[]> | null = null;
let cachedDocs: SearchDoc[] = [];

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

function getCachedIndex(docs: SearchDoc[]): { index: Map<string, number[]>; docs: SearchDoc[] } {
  const hashSource = docs.length > 0
    ? `${docs.length}:${docs[0].text.slice(0, 80)}:${docs[docs.length - 1].text.slice(-80)}`
    : "empty";
  const currentHash = createHash("sha256").update(hashSource).digest("hex");

  if (currentHash === cachedIndexHash && cachedIndex && cachedDocs.length === docs.length) {
    return { index: cachedIndex, docs: cachedDocs };
  }
  const index = buildIndex(docs);
  cachedIndexHash = currentHash;
  cachedIndex = index;
  cachedDocs = docs;
  return { index, docs };
}

// ── Main search ───────────────────────────────────────────────────────────

/**
 * Search blocks. When `query` is empty/omitted, returns all blocks as hits
 * (caller decides recent-window slicing).
 */
export const searchEntries = (
  blocks: NormalizedBlock[],
  query?: string,
): RecallHit[] => {
  const allDocs: SearchDoc[] = blocks.map((b, i) => ({
    id: i,
    text: blockText(b),
    kind: b.kind,
    files: blockFiles(b),
  }));

  if (!query?.trim()) {
    return allDocs.map((d) => ({
      index: d.id,
      score: 0,
      text: d.text,
      kind: d.kind,
      files: d.files.length > 0 ? d.files : undefined,
    }));
  }

  const rawQuery = query.trim();
  const checkBudget = startBudget();

  // If the query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms. Detection
  // is deliberately loose (ordinary prose trips it), so an empty regex result
  // falls through to term search below — mode detection must never silently
  // lose results.
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: RecallHit[] = [];
    for (let i = 0; i < allDocs.length; i++) {
      checkBudget();
      const d = allDocs[i];
      const hay = `${d.kind} ${d.text} ${d.files.join(" ")}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(d.text, regex);
        hits.push({ index: d.id, score: 1, text: d.text, kind: d.kind, snippet: snip, matchCount: 1, files: d.files.length > 0 ? d.files : undefined });
      }
    }
    if (hits.length > 0) return hits;
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  const docs = allDocs.map((d) => `${d.kind} ${d.text} ${d.files.join(" ")}`);
  const ctx = buildBM25Context(docs, terms, checkBudget);

  const scored: Array<{ hit: RecallHit; score: number }> = [];
  for (let i = 0; i < allDocs.length; i++) {
    checkBudget();
    const d = allDocs[i];
    const hay = docs[i];
    const mc = countMatches(hay, terms);
    if (mc === 0) continue;
    const score = bm25Score(hay, terms, ctx);
    const snip = lineSnippet(d.text, snipRe);
    scored.push({
      hit: {
        index: d.id,
        score,
        text: d.text,
        kind: d.kind,
        snippet: snip,
        matchCount: mc,
        files: d.files.length > 0 ? d.files : undefined,
      },
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.hit);
};

/** Backwards-compatible BM25-only search over blocks (legacy callers). */
export function searchEntriesLegacy(
  blocks: NormalizedBlock[],
  query: string,
  opts?: { limit?: number; offset?: number },
): SearchHit[] {
  const hits = searchEntries(blocks, query);
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 10;
  return hits.slice(offset, offset + limit).map((h) => ({
    docId: h.index,
    score: h.score,
    text: h.text.slice(0, 300),
    kind: h.kind,
  }));
}

// Keep the token-index cache warm for repeated legacy queries.
export function warmIndexCache(blocks: NormalizedBlock[]): void {
  const docs: SearchDoc[] = blocks.map((b, i) => ({
    id: i,
    text: blockText(b),
    kind: b.kind,
    files: blockFiles(b),
  }));
  getCachedIndex(docs);
}
