/**
 * ContentStore — FTS5 BM25-based knowledge base with trigram/fuzzy/RRF
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadSQLite, applyWALPragmas, withRetry, isSQLiteCorruptionError, defaultDBPath } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { autoChunk } from "./chunking.js";
import type { IndexResult, SearchResult, StoreStats } from "../types.js";

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

  constructor(opts?: { dbPath?: string }) {
    this.dbPath = opts?.dbPath ?? defaultDBPath("content");
  }

  async init(): Promise<void> {
    const { lib } = await loadSQLite();
    const Database = lib.Database ?? lib.default?.Database ?? lib;
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

    if (mode === "rrf") return rrfResults.slice(0, limit);

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
      const merged = rrfMerge(rrfResults, correctedResults);
      return merged.slice(0, limit);
    }

    return rrfResults.slice(0, limit);
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

  async purge(): Promise<number> {
    if (!this.ready) await this.init();
    this.db.exec(`DELETE FROM content_fts; DELETE FROM content_sources;`);
    const row = this.stmt("countSources").get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
