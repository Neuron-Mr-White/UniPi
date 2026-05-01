/**
 * SessionDB — Persistent per-project SQLite database for session events
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEvent, StoredEvent, SessionMeta, ResumeRow } from "../types.js";

export function getWorktreeSuffix(): string {
  const envSuffix = process.env.COMPACTOR_SESSION_SUFFIX;
  if (envSuffix !== undefined) {
    return envSuffix ? `__${envSuffix}` : "";
  }
  try {
    const cwd = process.cwd();
    const mainWorktree = execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      { encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    )
      .split(/\r?\n/)
      .find((l) => l.startsWith("worktree "))
      ?.replace("worktree ", "")
      ?.trim();

    if (mainWorktree && cwd !== mainWorktree) {
      const suffix = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
      return `__${suffix}`;
    }
  } catch {
    // git not available
  }
  return "";
}

function defaultDBPath(name: string): string {
  return join(homedir(), ".unipi", "db", "compactor", `${name}.db`);
}

// Simple SQLite abstraction using dynamic imports
let sqliteLib: any = null;

async function getSQLite() {
  if (sqliteLib) return sqliteLib;
  // Try bun:sqlite first (Bun runtime)
  try {
    sqliteLib = await import("bun:sqlite" as any);
    return sqliteLib;
  } catch {
    // Skip node:sqlite — its API (DatabaseSync) is incompatible with
    // better-sqlite3's constructor pattern used by SessionDB.
    // Go straight to better-sqlite3 which has the expected shape.
    sqliteLib = await import("better-sqlite3");
    return sqliteLib;
  }
}

interface PreparedStatement {
  get(...args: any[]): any;
  all(...args: any[]): any[];
  run(...args: any[]): { changes: number };
}

const MAX_EVENTS_PER_SESSION = 1000;
const DEDUP_WINDOW = 5;

export class SessionDB {
  private db: any;
  private stmts: Map<string, PreparedStatement> | null = null;
  private dbPath: string;

  constructor(opts?: { dbPath?: string }) {
    this.dbPath = opts?.dbPath ?? defaultDBPath("session");
  }

  async init(): Promise<void> {
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const sqlite: any = await getSQLite();
    // Handle different SQLite API shapes:
    // - bun:sqlite exports Database as a named export
    // - better-sqlite3 (CJS) exports the constructor as default when imported via ESM
    const Database = sqlite.Database ?? sqlite.default?.Database ?? sqlite.default ?? sqlite;
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.initSchema();
    this.prepareStatements();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Run version-gated schema migrations
    this.runMigrations();
  }

  /** Run version-gated schema migrations using PRAGMA user_version. */
  private runMigrations(): void {
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;

    if (currentVersion < 1) {
      // V1: Add columns introduced by compactor gap analysis (2026-04-30)
      // Each ALTER TABLE is wrapped individually — SQLite auto-commits DDL,
      // so a partial failure from a prior run would leave some columns added
      // and others not. We catch "duplicate column" to handle this safely.
      const safeAddColumn = (table: string, col: string, def: string) => {
        try {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        } catch (e: any) {
          if (e?.message?.includes("duplicate column")) return;
          throw e;
        }
      };
      safeAddColumn("session_meta", "total_chars_before", "INTEGER NOT NULL DEFAULT 0");
      safeAddColumn("session_meta", "total_chars_kept", "INTEGER NOT NULL DEFAULT 0");
      safeAddColumn("session_meta", "total_messages_summarized", "INTEGER NOT NULL DEFAULT 0");
      safeAddColumn("session_events", "attribution_source", "TEXT NOT NULL DEFAULT 'unknown'");
      safeAddColumn("session_events", "attribution_confidence", "REAL NOT NULL DEFAULT 0");
      safeAddColumn("session_events", "data_hash", "TEXT NOT NULL DEFAULT ''");
      this.db.pragma("user_version = 1");
    }
  }

  private prepareStatements(): void {
    this.stmts = new Map();
    const p = (key: string, sql: string) => {
      this.stmts!.set(key, this.db.prepare(sql) as PreparedStatement);
    };

    p("insertEvent", `INSERT INTO session_events (session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, source_hook, data_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    p("getEvents", `SELECT id, session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, source_hook, created_at, data_hash FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`);
    p("getEventCount", `SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?`);
    p("checkDuplicate", `SELECT 1 FROM (SELECT type, data_hash FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?) AS recent WHERE recent.type = ? AND recent.data_hash = ? LIMIT 1`);
    p("evictLowestPriority", `DELETE FROM session_events WHERE id = (SELECT id FROM session_events WHERE session_id = ? ORDER BY priority ASC, id ASC LIMIT 1)`);
    p("updateMetaLastEvent", `UPDATE session_meta SET last_event_at = datetime('now'), event_count = event_count + 1 WHERE session_id = ?`);
    p("ensureSession", `INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)`);
    p("getSessionStats", `SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count, total_chars_before, total_chars_kept, total_messages_summarized FROM session_meta WHERE session_id = ?`);
    p("incrementCompactCount", `UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?`);
    p("addCompactionStats", `UPDATE session_meta SET total_chars_before = total_chars_before + ?, total_chars_kept = total_chars_kept + ?, total_messages_summarized = total_messages_summarized + ? WHERE session_id = ?`);
    p("getAllTimeStats", `SELECT COALESCE(SUM(total_chars_before), 0) AS all_chars_before, COALESCE(SUM(total_chars_kept), 0) AS all_chars_kept, COALESCE(SUM(total_messages_summarized), 0) AS all_messages_summarized, COALESCE(SUM(compact_count), 0) AS all_compactions FROM session_meta`);
    p("upsertResume", `INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET snapshot = excluded.snapshot, event_count = excluded.event_count, created_at = datetime('now'), consumed = 0`);
    p("getResume", `SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?`);
    p("markResumeConsumed", `UPDATE session_resume SET consumed = 1 WHERE session_id = ?`);
    p("deleteEvents", `DELETE FROM session_events WHERE session_id = ?`);
    p("deleteMeta", `DELETE FROM session_meta WHERE session_id = ?`);
    p("deleteResume", `DELETE FROM session_resume WHERE session_id = ?`);
    p("getOldSessions", `SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')`);
  }

  private stmt(key: string): PreparedStatement {
    return this.stmts!.get(key)!;
  }

  insertEvent(sessionId: string, event: SessionEvent, sourceHook: string = "PostToolUse"): void {
    if (!this.stmts) return;
    const dataHash = createHash("sha256").update(event.data).digest("hex").slice(0, 16).toUpperCase();
    const projectDir = String(event.project_dir ?? "").trim();
    const attributionSource = String(event.attribution_source ?? "unknown");
    const rawConfidence = Number(event.attribution_confidence ?? 0);
    const attributionConfidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0;

    const transaction = this.db.transaction(() => {
      const dup = this.stmt("checkDuplicate").get(sessionId, DEDUP_WINDOW, event.type, dataHash);
      if (dup) return;

      const countRow = this.stmt("getEventCount").get(sessionId) as { cnt: number };
      if (countRow.cnt >= MAX_EVENTS_PER_SESSION) {
        this.stmt("evictLowestPriority").run(sessionId);
      }

      this.stmt("insertEvent").run(
        sessionId, event.type, event.category, event.priority, event.data,
        projectDir, attributionSource, attributionConfidence, sourceHook, dataHash,
      );
      this.stmt("updateMetaLastEvent").run(sessionId);
    });

    transaction();
  }

  getEvents(sessionId: string, opts?: { type?: string; minPriority?: number; limit?: number }): StoredEvent[] {
    if (!this.stmts) return [];
    const limit = opts?.limit ?? 1000;
    return this.stmt("getEvents").all(sessionId, limit) as StoredEvent[];
  }

  getEventCount(sessionId: string): number {
    if (!this.stmts) return 0;
    const row = this.stmt("getEventCount").get(sessionId) as { cnt: number };
    return row.cnt;
  }

  ensureSession(sessionId: string, projectDir: string): void {
    if (!this.stmts) return;
    this.stmt("ensureSession").run(sessionId, projectDir);
  }

  getSessionStats(sessionId: string): SessionMeta | null {
    if (!this.stmts) return null;
    const row = this.stmt("getSessionStats").get(sessionId) as SessionMeta | undefined;
    return row ?? null;
  }

  incrementCompactCount(sessionId: string): void {
    if (!this.stmts) return;
    this.stmt("incrementCompactCount").run(sessionId);
  }

  addCompactionStats(sessionId: string, charsBefore: number, charsKept: number, messagesSummarized: number): void {
    if (!this.stmts) return;
    this.stmt("addCompactionStats").run(charsBefore, charsKept, messagesSummarized, sessionId);
  }

  getAllTimeStats(): { allCharsBefore: number; allCharsKept: number; allMessagesSummarized: number; allCompactions: number } {
    if (!this.stmts) return { allCharsBefore: 0, allCharsKept: 0, allMessagesSummarized: 0, allCompactions: 0 };
    const row = this.stmt("getAllTimeStats").get() as { all_chars_before: number; all_chars_kept: number; all_messages_summarized: number; all_compactions: number };
    return {
      allCharsBefore: row?.all_chars_before ?? 0,
      allCharsKept: row?.all_chars_kept ?? 0,
      allMessagesSummarized: row?.all_messages_summarized ?? 0,
      allCompactions: row?.all_compactions ?? 0,
    };
  }

  upsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
    if (!this.stmts) return;
    this.stmt("upsertResume").run(sessionId, snapshot, eventCount ?? 0);
  }

  getResume(sessionId: string): ResumeRow | null {
    if (!this.stmts) return null;
    const row = this.stmt("getResume").get(sessionId) as ResumeRow | undefined;
    return row ?? null;
  }

  markResumeConsumed(sessionId: string): void {
    if (!this.stmts) return;
    this.stmt("markResumeConsumed").run(sessionId);
  }

  deleteSession(sessionId: string): void {
    if (!this.stmts) return;
    this.db.transaction(() => {
      this.stmt("deleteEvents").run(sessionId);
      this.stmt("deleteResume").run(sessionId);
      this.stmt("deleteMeta").run(sessionId);
    })();
  }

  cleanupOldSessions(maxAgeDays: number = 7): number {
    if (!this.stmts) return 0;
    const oldSessions = this.stmt("getOldSessions").all(`-${maxAgeDays}`) as Array<{ session_id: string }>;
    for (const { session_id } of oldSessions) {
      this.deleteSession(session_id);
    }
    return oldSessions.length;
  }

  /** Expose the underlying db for AnalyticsEngine (read-only queries). Returns null if init failed. */
  getDb(): any { return this.db ?? null; }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }
}
