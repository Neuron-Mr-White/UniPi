/**
 * ContentStore — FTS5 BM25-based knowledge base
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadSQLite, applyWALPragmas, withRetry, isSQLiteCorruptionError, defaultDBPath } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { autoChunk } from "./chunking.js";
import type { IndexResult, SearchResult, StoreStats } from "../types.js";

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

  async search(query: string, opts?: { limit?: number; offset?: number }): Promise<SearchResult[]> {
    if (!this.ready) await this.init();

    const sanitized = sanitizeQuery(query);
    const limit = opts?.limit ?? 10;
    const rows = this.stmt("searchFTS").all(sanitized, limit) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
      source: string;
      rank: number;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.source,
      rank: r.rank,
      contentType: r.content_type === "markdown" || r.content_type === "json" ? "prose" : "code",
      matchLayer: "porter",
    }));
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
