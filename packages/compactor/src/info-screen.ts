import { formatTokens } from "@pi-unipi/core";
/**
 * Info-screen integration for @pi-unipi/compactor
 *
 * Stats driven by COMPACTION SAVINGS (the compactor's actual value),
 * not sandbox/index diversion bytes.
 *
 * Data sources (in priority order):
 * 1. Runtime counters (in-memory, current session only)
 * 2. DB compaction stats (total_chars_before/kept in session_meta)
 * 3. Session event counts (session_events table, always reliable)
 */

import type { SessionDB } from "./session/db.js";
import { getLastCompactionStats, formatCompactionStats } from "./compaction/hooks.js";
import { parseUsageStatsAsync } from "@pi-unipi/info-screen/usage-parser.js";
import type { RuntimeCounters } from "./types.js";

export interface CompactorInfoData {
  tokensSaved: { value: string; detail: string };
  costSaved: { value: string; detail: string };
  pctReduction: { value: string; detail: string };
  topTools: { value: string; detail: string };
  compactions: { value: string; detail: string };
  toolCalls: { value: string; detail: string };
}

/** Format token count for display (e.g., "12.4k", "1.2M"). */
/** Format cost for display (e.g., "$0.34", "<$0.01"). */
function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

/** Estimate cost per token for the most-used model in the current session. */
async function estimateCostPerToken(): Promise<number | null> {
  try {
    const usage = await parseUsageStatsAsync();
    // Use today's most-used model if available, otherwise all-time
    const models = usage.byModelToday;
    const todayKeys = Object.keys(models);
    if (todayKeys.length > 0) {
      const topModel = todayKeys.reduce((a, b) => models[a].tokens > models[b].tokens ? a : b);
      const entry = models[topModel];
      if (entry.tokens > 0 && entry.cost > 0) {
        return entry.cost / entry.tokens;
      }
    }
    // Fall back to all-time model data
    const allKeys = Object.keys(usage.byModel);
    if (allKeys.length > 0) {
      const topModel = allKeys.reduce((a, b) => usage.byModel[a].tokens > usage.byModel[b].tokens ? a : b);
      const entry = usage.byModel[topModel];
      if (entry.tokens > 0 && entry.cost > 0) {
        return entry.cost / entry.tokens;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function getInfoScreenData(
  sessionDB: SessionDB,
  sessionId: string,
  counters?: RuntimeCounters,
): Promise<CompactorInfoData> {
  try {
    // ── Compaction savings (the compactor's actual value) ──
    // Priority: in-memory counter → DB per-session stats → DB all-time stats
    let tokensSaved = counters?.totalTokensCompacted ?? 0;
    let charsBefore = 0;
    let charsKept = 0;

    if (tokensSaved === 0) {
      // Try DB per-session stats
      const sessionStats = sessionDB.getSessionStats(sessionId);
      if (sessionStats) {
        charsBefore = (sessionStats as any).total_chars_before ?? 0;
        charsKept = (sessionStats as any).total_chars_kept ?? 0;
        tokensSaved = Math.round((charsBefore - charsKept) / 4);
      }
    }

    if (tokensSaved === 0) {
      // Try DB all-time stats
      const allTime = sessionDB.getAllTimeStats();
      charsBefore = allTime.allCharsBefore;
      charsKept = allTime.allCharsKept;
      tokensSaved = Math.round((charsBefore - charsKept) / 4);
    }

    // ── Compaction count ──
    let compactionCount = counters?.compactions ?? 0;
    if (compactionCount === 0) {
      const allTime = sessionDB.getAllTimeStats();
      compactionCount = allTime.allCompactions;
    }

    // ── Compression ratio / pct reduction ──
    let pctReduction = 0;
    if (charsBefore > 0) {
      pctReduction = Math.round((1 - charsKept / charsBefore) * 100);
    }

    // ── Tool call counts from session_events (always reliable) ──
    // The session_events table captures every tool_result event, so this
    // is an accurate count regardless of runtimeStats state.
    interface ToolCountRow { category: string; cnt: number }
    let toolCountRows: ToolCountRow[] = [];
    let totalToolCalls = 0;
    try {
      const db = sessionDB.getDb();
      if (db) {
        toolCountRows = db.prepare(
          "SELECT category, COUNT(*) as cnt FROM session_events WHERE session_id = ? GROUP BY category",
        ).all(sessionId) as ToolCountRow[];
        for (const row of toolCountRows) {
          totalToolCalls += row.cnt;
        }
      }
    } catch {
      // Non-fatal: DB query failed, show zero
    }

    // Build per-tool breakdown for display
    const toolBreakdown = toolCountRows.length > 0
      ? toolCountRows
          .sort((a, b) => b.cnt - a.cnt)
          .map(r => `  ${r.category.padEnd(20)} ${String(r.cnt).padStart(5)} events`)
          .join("\n")
      : "No tool calls yet";

    const topCategory = toolCountRows.length > 0
      ? toolCountRows.reduce((a, b) => a.cnt > b.cnt ? a : b)
      : null;

    const top5Detail = toolCountRows.length > 0
      ? toolCountRows
          .sort((a, b) => b.cnt - a.cnt)
          .slice(0, 5)
          .map(r => `${r.category}: ${r.cnt} events`)
          .join("\n")
      : "No tool calls yet";

    // ── Cost saved estimate ──
    const costPerToken = await estimateCostPerToken();
    const costSaved = costPerToken !== null ? tokensSaved * costPerToken : null;

    // ── Last compaction details ──
    const compactStats = getLastCompactionStats();

    return {
      tokensSaved: {
        value: formatTokens(tokensSaved),
        detail: toolBreakdown,
      },
      costSaved: {
        value: costSaved !== null ? formatCost(costSaved) : "N/A",
        detail: costSaved !== null
          ? `~${formatTokens(tokensSaved)} tokens × $${(costPerToken! * 1_000_000).toFixed(2)}/M tokens`
          : "Cost data unavailable for current model",
      },
      pctReduction: {
        value: `${pctReduction}%`,
        detail: charsBefore > 0
          ? `${formatTokens(Math.round(charsBefore / 4))} before → ${formatTokens(Math.round(charsKept / 4))} after compaction`
          : "No compaction data yet",
      },
      topTools: {
        value: topCategory ? `${topCategory.category}: ${topCategory.cnt}` : "N/A",
        detail: top5Detail,
      },
      compactions: {
        value: String(compactionCount),
        detail: compactStats
          ? `Last: ${formatCompactionStats(compactStats)}`
          : compactionCount > 0
            ? `${compactionCount} compaction(s) across all sessions`
            : "No compactions yet",
      },
      toolCalls: {
        value: String(totalToolCalls),
        detail: `${totalToolCalls} events across ${toolCountRows.length} categor${toolCountRows.length !== 1 ? "ies" : "y"}`,
      },
    };
  } catch {
    // Never throw from dataProvider — return zeroed stats
    return {
      tokensSaved: { value: "0", detail: "No data" },
      costSaved: { value: "N/A", detail: "No data" },
      pctReduction: { value: "0%", detail: "No data" },
      topTools: { value: "N/A", detail: "No data" },
      compactions: { value: "0", detail: "No data" },
      toolCalls: { value: "0", detail: "No data" },
    };
  }
}
