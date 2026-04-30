/**
 * ContentStore — FTS5 BM25-based knowledge base with trigram/fuzzy/RRF
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadSQLite, applyWALPragmas, withRetry, isSQLiteCorruptionError, defaultDBPath } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { autoChunk } from "./chunking.js";
import type { IndexResult, SearchResult, StoreStats } from "../types.js";
import { loadConfig } from "../config/manager.js";

// --- Fuzzy correction ---

/** Build a vocabulary from indexed content for fuzzy suggestions */
function buildVocabulary(rows: Array<{ content: string }>): Set<string> {
  const vocab = new Set<string>();
  for (const row of rows) {
    const words = row.content.toLowerCase().match(/[a-z_]{3,}/g) ?? [];
    for (const w of words) vocab.add(w);
  }
  return vocab;
}

/** Levenshtein distance for fuzzy matching */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

/** Find closest vocabulary word for fuzzy correction */
function fuzzySuggest(word: string, vocab: Set<string>, maxDistance = 2): string | undefined {
  const lower = word.toLowerCase();
  let best: string | undefined;
  let bestDist = maxDistance + 1;
  for (const v of vocab) {
    if (Math.abs(v.length - lower.length) > maxDistance) continue;
    const dist = levenshtein(lower, v);
    if (dist < bestDist && dist <= maxDistance) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

/** Trigram similarity for fuzzy matching */
function trigramSimilarity(a: string, b: string): number {
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    const padded = `  ${s} `;
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const aTri = trigrams(a.toLowerCase());
  const bTri = trigrams(b.toLowerCase());
  let intersection = 0;
  for (const t of aTri) if (bTri.has(t)) intersection++;
  return intersection / (aTri.size + bTri.size - intersection);
}

/** Trigram search: find rows with high trigram similarity to query */
function trigramSearch(rows: Array<{ title: string; content: string; content_type: string; label: string; source: string; rank: number }>, query: string, limit: number): SearchResult[] {
  const queryLower = query.toLowerCase();
  const scored = rows
    .map((r) => ({
      ...r,
      trigramScore: Math.max(
        trigramSimilarity(queryLower, r.title.toLowerCase()),
        trigramSimilarity(queryLower, r.content.toLowerCase().slice(0, 200)),
      ),
    }))
    .filter((r) => r.trigramScore > 0.1)
    .sort((a, b) => b.trigramScore - a.trigramScore)
    .slice(0, limit);

  return scored.map((r) => ({
    title: r.title,
    content: r.content,
    source: r.source,
    rank: r.trigramScore,
    contentType: r.content_type === "markdown" || r.content_type === "json" ? "prose" as const : "code" as const,
    matchLayer: "trigram" as const,
  }));
}

/** Reciprocal Rank Fusion: merge results from multiple search layers */
function rrfMerge(
  porterResults: SearchResult[],
  trigramResults: SearchResult[],
  k = 60,
): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (let i = 0; i < porterResults.length; i++) {
    const key = porterResults[i].title + porterResults[i].source;
    const existing = scores.get(key);
    const rrfScore = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(key, { result: { ...porterResults[i], matchLayer: "rrf" }, score: rrfScore });
    }
  }

  for (let i = 0; i < trigramResults.length; i++) {
    const key = trigramResults[i].title + trigramResults[i].source;
    const existing = scores.get(key);
    const rrfScore = 1 / (k + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(key, { result: { ...trigramResults[i], matchLayer: "rrf" }, score: rrfScore });
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ ...s.result, rank: s.score }));
}

// ── Proximity Reranking (from context-mode) ──────────────────

/** Find all character positions of a term in text */
function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/** Sweep-line algorithm to find minimum span covering all terms */
function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists.map((p) => [...p].sort((a, b) => a - b));
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) { curMin = val; minIdx = i; }
      if (val > curMax) { curMax = val; }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

/** Count adjacent term pairs within a character gap */
function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap: number = 30,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  let total = 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i];
    const right = positionLists[i + 1];
    const leftLen = terms[i].length;
    let j = 0;
    for (const p of left) {
      const minStart = p + leftLen;
      const maxStart = minStart + gap;
      while (j < right.length && right[j] < minStart) j++;
      if (j < right.length && right[j] <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/** Apply proximity reranking to RRF results */
function applyProximityReranking(
  results: SearchResult[],
  query: string,
): SearchResult[] {
  const allTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
  const terms = filtered.length > 0 ? filtered : allTerms;

  if (terms.length < 2) return results; // Single-term queries skip proximity

  const scored = results.map((r) => {
    const titleLower = r.title.toLowerCase();
    const titleHits = terms.filter((t) => titleLower.includes(t)).length;
    const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
    const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

    let proximityBoost = 0;
    let phraseBoost = 0;

    const content = r.content.toLowerCase();
    const positions = terms.map((t) => findAllPositions(content, t));

    if (!positions.some((p) => p.length === 0)) {
      const minSpan = findMinSpan(positions);
      proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

      const adjacentPairs = countAdjacentPairs(positions, terms);
      phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
    }

    return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
  });

  return scored
    .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
    .map((s) => s.result);
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = dedupeTokens(
    query.replace(/['"(){}[\]*:^~]/g, " ").split(/\s+/).filter(
      (w) => w.length > 0 && !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
    ),
  );
  if (words.length === 0) return '""';
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;
  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export class ContentStore {
  private db: any;
  private stmts: Map<string, PreparedStatement> = new Map();
  private dbPath: string;
  private ready = false;
  private writeCount = 0;

  constructor(opts?: { dbPath?: string }) {
    this.dbPath = opts?.dbPath ?? defaultDBPath("content");
  }

  async init(): Promise<void> {
    const { lib } = await loadSQLite();
    // Handle different SQLite API shapes:
    // - bun:sqlite exports Database as a named export
    // - better-sqlite3 (CJS) exports the constructor as default when imported via ESM
    const Database = lib.Database ?? lib.default?.Database ?? lib.default ?? lib;
    this.db = new Database(this.dbPath);
    applyWALPragmas(this.db);
    this.initSchema();
    this.prepareStatements();
    this.ready = true;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
        title, content, content_type, label, source,
        tokenize='porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS content_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'plain',
        mtime INTEGER,
        sha256 TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON content_sources(label);
    `);
  }

  private prepareStatements(): void {
    const p = (key: string, sql: string) => {
      this.stmts.set(key, this.db.prepare(sql) as PreparedStatement);
    };

    p("insertFTS", `INSERT INTO content_fts (title, content, content_type, label, source) VALUES (?, ?, ?, ?, ?)`);
    p("searchFTS", `SELECT title, content, content_type, label, source, rank FROM content_fts WHERE content_fts MATCH ? ORDER BY rank LIMIT ?`);
    p("searchFTSAll", `SELECT title, content, content_type, label, source, rank FROM content_fts ORDER BY rank LIMIT ?`);
    p("deleteByLabel", `DELETE FROM content_fts WHERE label = ?`);
    p("insertSource", `INSERT INTO content_sources (label, source, content_type, mtime, sha256, chunk_count) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(label) DO UPDATE SET source=excluded.source, content_type=excluded.content_type, mtime=excluded.mtime, sha256=excluded.sha256, chunk_count=excluded.chunk_count, indexed_at=datetime('now')`);
    p("getSource", `SELECT label, source, content_type, mtime, sha256, chunk_count, indexed_at FROM content_sources WHERE label = ?`);
    p("getSourceMeta", `SELECT label, chunk_count, indexed_at FROM content_sources WHERE label = ?`);
    p("deleteSource", `DELETE FROM content_sources WHERE label = ?`);
    p("countSources", `SELECT COUNT(*) AS cnt FROM content_sources`);
    p("countFTS", `SELECT COUNT(*) AS cnt FROM content_fts`);
  }

  private stmt(key: string): PreparedStatement {
    return this.stmts.get(key)!;
  }

  async index(label: string, text: string, opts?: { contentType?: "markdown" | "json" | "plain"; source?: string; chunkSize?: number }): Promise<IndexResult> {
    if (!this.ready) await this.init();

    const contentType = opts?.contentType ?? "plain";
    const source = opts?.source ?? label;
    const chunkSize = opts?.chunkSize ?? 4096;

    // Check staleness for file-backed sources
    let mtime: number | undefined;
    let sha256: string | undefined;
    if (existsSync(source)) {
      const stat = statSync(source);
      mtime = stat.mtimeMs;
      const existing = this.stmt("getSource").get(label) as { mtime?: number; sha256?: string } | undefined;
      if (existing?.mtime === mtime) {
        return { sourceId: -1, label, totalChunks: existing.sha256 ? parseInt(existing.sha256) : 0, codeChunks: 0 };
      }
      sha256 = createHash("sha256").update(text).digest("hex");
    }

    // Delete old chunks
    this.stmt("deleteByLabel").run(label);

    const chunks = autoChunk(text, contentType, chunkSize);
    let codeChunks = 0;

    const transaction = this.db.transaction(() => {
      for (const chunk of chunks) {
        this.stmt("insertFTS").run(chunk.title, chunk.content, contentType, label, source);
        if (chunk.hasCode) codeChunks++;
      }
      this.stmt("insertSource").run(label, source, contentType, mtime ?? null, sha256 ?? null, chunks.length);
    });

    withRetry(() => transaction());
    this.afterWrite();

    return { sourceId: 1, label, totalChunks: chunks.length, codeChunks };
  }

  async search(query: string, opts?: { limit?: number; offset?: number; mode?: "porter" | "trigram" | "rrf" | "fuzzy" }): Promise<SearchResult[]> {
    if (!this.ready) await this.init();

    const limit = opts?.limit ?? 10;
    const mode = opts?.mode ?? "rrf";
    const sanitized = sanitizeQuery(query);

    // Porter stemmer search (FTS5 default)
    const porterRows = this.stmt("searchFTS").all(sanitized, limit * 2) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
      source: string;
      rank: number;
    }>;

    const porterResults: SearchResult[] = porterRows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.source,
      rank: r.rank,
      contentType: r.content_type === "markdown" || r.content_type === "json" ? "prose" as const : "code" as const,
      matchLayer: "porter" as const,
    }));

    if (mode === "porter") return porterResults.slice(0, limit);

    // Trigram search
    const allRows = this.stmt("searchFTSAll").all(limit * 3) as typeof porterRows;
    const trigramResults = trigramSearch(allRows, query, limit * 2);

    if (mode === "trigram") return trigramResults.slice(0, limit);

    // RRF fusion
    const rrfResults = rrfMerge(porterResults, trigramResults);

    // Apply proximity reranking to all RRF results (if enabled)
    const config = loadConfig();
    const rerankedResults = config.pipeline.proximityReranking
      ? applyProximityReranking(rrfResults, query)
      : rrfResults;

    if (mode === "rrf") return rerankedResults.slice(0, limit);

    // Fuzzy mode: apply fuzzy correction to query terms
    const vocab = buildVocabulary(allRows);
    const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const corrections: string[] = [];
    for (const word of queryWords) {
      const suggestion = fuzzySuggest(word, vocab);
      if (suggestion && suggestion !== word) corrections.push(`${word} → ${suggestion}`);
    }

    if (corrections.length > 0 && rrfResults.length < 3) {
      // Re-search with corrected terms
      const correctedQuery = queryWords
        .map((w) => fuzzySuggest(w, vocab) ?? w)
        .join(" ");
      const correctedSanitized = sanitizeQuery(correctedQuery);
      const correctedRows = this.stmt("searchFTS").all(correctedSanitized, limit * 2) as typeof porterRows;
      const correctedResults: SearchResult[] = correctedRows.map((r) => ({
        ...r,
        contentType: r.content_type === "markdown" || r.content_type === "json" ? "prose" as const : "code" as const,
        matchLayer: "fuzzy" as const,
        rank: r.rank * 0.9, // slightly lower confidence
      }));
      const merged = rrfMerge(rerankedResults, correctedResults);
      return applyProximityReranking(merged, query).slice(0, limit);
    }

    return rerankedResults.slice(0, limit);
  }

  async getStats(): Promise<StoreStats> {
    if (!this.ready) await this.init();
    const sourcesRow = this.stmt("countSources").get() as { cnt: number };
    const chunksRow = this.stmt("countFTS").get() as { cnt: number };
    return {
      sources: sourcesRow.cnt,
      chunks: chunksRow.cnt,
      codeChunks: 0,
    };
  }

  /** Get source metadata for TTL cache check */
  getSourceMeta(label: string): { label: string; chunkCount: number; indexedAt: string } | null {
    const row = this.stmt("getSourceMeta").get(label) as { label: string; chunk_count: number; indexed_at: string } | undefined;
    if (!row) return null;
    return { label: row.label, chunkCount: row.chunk_count, indexedAt: row.indexed_at };
  }

  async purge(): Promise<number> {
    if (!this.ready) await this.init();
    this.db.exec(`DELETE FROM content_fts; DELETE FROM content_sources;`);
    this.afterWrite();
    const row = this.stmt("countSources").get() as { cnt: number };
    return row.cnt;
  }

  /** Run WAL checkpoint to prevent unbounded WAL file growth. */
  checkpointWAL(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): void {
    if (!this.db) return;
    try {
      this.db.exec(`PRAGMA wal_checkpoint(${mode});`);
    } catch { /* ignore */ }
  }

  /** Increment write counter and trigger PASSIVE checkpoint every 10th write. */
  private afterWrite(): void {
    this.writeCount++;
    if (this.writeCount % 10 === 0) {
      this.checkpointWAL("PASSIVE");
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
