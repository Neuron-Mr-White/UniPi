/**
 * AnalyticsEngine — Runtime savings + session continuity reporting.
 *
 * Ported from context-mode's AnalyticsEngine, trimmed to budget-focused stats.
 * Omits: formatReport(), categoryLabels, categoryHints, ThinkInCodeComparison,
 * SandboxIO, dataBar(), visual formatting helpers.
 *
 * Usage:
 *   const engine = new AnalyticsEngine(sessionDb);
 *   const report = engine.queryAll(runtimeStats);
 */

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Context savings result */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Runtime stats tracked during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheBytesSaved: number;
}

/** Unified report combining runtime stats, DB analytics, and continuity data. */
export interface FullReport {
  /** Runtime context savings */
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  /** Session metadata from SessionDB */
  session: {
    id: string;
    uptime_min: string;
  };
  /** Session continuity data */
  continuity: {
    total_events: number;
    compact_count: number;
    resume_ready: boolean;
  };
  /** Persistent project memory — all events across all sessions */
  projectMemory: {
    total_events: number;
    session_count: number;
  };
}

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  /**
   * Build a FullReport by merging runtime stats (passed in)
   * with continuity data from the DB.
   */
  queryAll(runtimeStats: RuntimeStats): FullReport {
    // ── Resolve latest session ID ──
    const latestSession = this.db.prepare(
      "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { session_id: string } | undefined;
    const sid = latestSession?.session_id ?? "";

    // ── Runtime savings ──
    const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce(
      (sum, b) => sum + b, 0,
    );
    const totalCalls = Object.values(runtimeStats.calls).reduce(
      (sum, c) => sum + c, 0,
    );
    const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0
      ? Math.round((1 - totalBytesReturned / totalProcessed) * 100)
      : 0;

    const toolNames = new Set([
      ...Object.keys(runtimeStats.calls),
      ...Object.keys(runtimeStats.bytesReturned),
    ]);
    const byTool = Array.from(toolNames).sort().map((tool) => ({
      tool,
      calls: runtimeStats.calls[tool] || 0,
      context_kb: Math.round((runtimeStats.bytesReturned[tool] || 0) / 1024 * 10) / 10,
      tokens: Math.round((runtimeStats.bytesReturned[tool] || 0) / 4),
    }));

    const uptimeMs = Date.now() - runtimeStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // ── Continuity data (scoped to current session) ──
    const eventTotal = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?",
    ).get(sid) as { cnt: number }).cnt;

    const meta = this.db.prepare(
      "SELECT compact_count FROM session_meta WHERE session_id = ?",
    ).get(sid) as { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db.prepare(
      "SELECT event_count, consumed FROM session_resume WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sid) as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // ── Project-wide persistent memory (all sessions, no session_id filter) ──
    const projectTotals = this.db.prepare(
      "SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions FROM session_events",
    ).get() as { cnt: number; sessions: number };

    return {
      savings: {
        processed_kb: Math.round(totalProcessed / 1024 * 10) / 10,
        entered_kb: Math.round(totalBytesReturned / 1024 * 10) / 10,
        saved_kb: Math.round(keptOut / 1024 * 10) / 10,
        pct: reductionPct,
        savings_ratio: Math.round(savingsRatio * 10) / 10,
        by_tool: byTool,
        total_calls: totalCalls,
        total_bytes_returned: totalBytesReturned,
        kept_out: keptOut,
        total_processed: totalProcessed,
      },
      session: {
        id: sid,
        uptime_min: uptimeMin,
      },
      continuity: {
        total_events: eventTotal,
        compact_count: compactCount,
        resume_ready: resumeReady,
      },
      projectMemory: {
        total_events: projectTotals.cnt,
        session_count: projectTotals.sessions,
      },
    };
  }
}

// ─────────────────────────────────────────────────────────
// createMinimalDb — in-memory SQLite fallback
// ─────────────────────────────────────────────────────────

/**
 * Create a minimal in-memory DatabaseAdapter for when SessionDB is unavailable.
 * Returns zeroed/empty results for all queries.
 */
export function createMinimalDb(): DatabaseAdapter {
  // Use an in-memory SQLite database with the expected schema
  // so AnalyticsEngine queries don't fail.
  const emptyStmt = {
    run: (..._params: unknown[]) => {},
    get: (..._params: unknown[]) => ({ cnt: 0, sessions: 0, compact_count: 0, session_id: "", event_count: 0, consumed: 1 }),
    all: (..._params: unknown[]) => [] as unknown[],
  };

  return {
    prepare: (_sql: string) => emptyStmt,
  };
}
