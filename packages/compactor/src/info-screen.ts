/**
 * Info-screen integration for @pi-unipi/compactor
 *
 * Budget-focused stats: tokensSaved, costSaved, pctReduction,
 * topTools, compactions, toolCalls.
 */

import type { SessionDB } from "./session/db.js";
import type { RuntimeStats, FullReport } from "./session/analytics.js";
import { AnalyticsEngine, createMinimalDb } from "./session/analytics.js";
import { getLastCompactionStats } from "./compaction/hooks.js";
import { parseUsageStats } from "@pi-unipi/info-screen/usage-parser.js";

export interface CompactorInfoData {
  tokensSaved: { value: string; detail: string };
  costSaved: { value: string; detail: string };
  pctReduction: { value: string; detail: string };
  topTools: { value: string; detail: string };
  compactions: { value: string; detail: string };
  toolCalls: { value: string; detail: string };
}

/** Format token count for display (e.g., "12.4k", "1.2M"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** Format cost for display (e.g., "$0.34", "<$0.01"). */
function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}

/** Estimate cost per token for the most-used model in the current session. */
function estimateCostPerToken(): number | null {
  try {
    const usage = parseUsageStats();
    // Use today's most-used model if available, otherwise all-time
    const models = usage.byModelToday;
    const todayKeys = Object.keys(models);
    if (todayKeys.length > 0) {
      // Pick the model with most tokens today
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
  runtimeStats: RuntimeStats,
): Promise<CompactorInfoData> {
  try {
    const db = sessionDB.getDb();
    const adapter = db ?? createMinimalDb();
    const engine = new AnalyticsEngine(adapter);
    const report = engine.queryAll(runtimeStats);
    const compactStats = getLastCompactionStats();

    // Tokens saved: bytes kept out of context / 4
    const tokensSaved = Math.round(report.savings.kept_out / 4);

    // Per-tool breakdown table for tokensSaved detail
    const toolsWithCalls = report.savings.by_tool
      .filter(t => t.calls > 0)
      .sort((a, b) => b.tokens - a.tokens);
    const toolBreakdown = toolsWithCalls.length > 0
      ? toolsWithCalls.map(t =>
          `  ${t.tool.padEnd(20)} ${String(t.calls).padStart(4)} calls  ${formatTokens(t.tokens).padStart(8)} tok`
        ).join("\n")
      : "No tool calls yet";

    // Cost saved: tokensSaved × cost per token
    const costPerToken = estimateCostPerToken();
    const costSaved = costPerToken !== null ? tokensSaved * costPerToken : null;

    // Top consuming tool
    const topTool = toolsWithCalls[0];
    const top5Tools = toolsWithCalls.slice(0, 5);
    const top5Detail = top5Tools.length > 0
      ? top5Tools.map(t =>
          `${t.tool}: ${formatTokens(t.tokens)} (${t.calls} calls)`
        ).join("\n")
      : "No tool calls yet";

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
        value: `${report.savings.pct}%`,
        detail: `${formatTokens(Math.round(report.savings.processed_kb * 1024 / 4))} processed → ${formatTokens(Math.round(report.savings.entered_kb * 1024 / 4))} entered context`,
      },
      topTools: {
        value: topTool ? `${topTool.tool}: ${formatTokens(topTool.tokens)}` : "N/A",
        detail: top5Detail,
      },
      compactions: {
        value: String(report.continuity.compact_count),
        detail: compactStats
          ? `Last: ${compactStats.summarized} msgs summarized, ${compactStats.kept} kept (~${formatTokens(compactStats.keptTokensEst)} tok)`
          : report.continuity.compact_count > 0
            ? `${report.continuity.compact_count} compaction(s) this session`
            : "No compactions yet",
      },
      toolCalls: {
        value: String(report.savings.total_calls),
        detail: `${report.savings.total_calls} total tool calls across ${toolsWithCalls.length} tool${toolsWithCalls.length !== 1 ? "s" : ""}`,
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
