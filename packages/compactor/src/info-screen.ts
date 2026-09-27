import { formatTokens } from "@pi-unipi/core";
/**
 * Info-screen integration for @pi-unipi/compactor — this session's
 * compaction savings, read from the session branch.
 */

import { parseUsageStatsAsync } from "@pi-unipi/info-screen/usage-parser.js";
import { getLastCompactionStats, formatCompactionStats } from "./compaction/hooks.js";
import { sessionCompactionStats } from "./stats.js";

export interface CompactorInfoData {
  tokensSaved: { value: string; detail: string };
  costSaved: { value: string; detail: string };
  pctReduction: { value: string; detail: string };
  topTools: { value: string; detail: string };
  compactions: { value: string; detail: string };
  toolCalls: { value: string; detail: string };
}

function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Estimate cost per token for the most-used model (today, else all-time). */
async function estimateCostPerToken(): Promise<number | null> {
  try {
    const usage = await parseUsageStatsAsync();
    for (const models of [usage.byModelToday, usage.byModel]) {
      const keys = Object.keys(models);
      if (keys.length === 0) continue;
      const top = keys.reduce((a, b) => (models[a].tokens > models[b].tokens ? a : b));
      const entry = models[top];
      if (entry.tokens > 0 && entry.cost > 0) return entry.cost / entry.tokens;
    }
    return null;
  } catch {
    return null;
  }
}

const EMPTY: CompactorInfoData = {
  tokensSaved: { value: "0", detail: "No data" },
  costSaved: { value: "N/A", detail: "No data" },
  pctReduction: { value: "0%", detail: "No data" },
  topTools: { value: "N/A", detail: "No data" },
  compactions: { value: "0", detail: "No data" },
  toolCalls: { value: "0", detail: "No data" },
};

export async function getInfoScreenData(branch: readonly any[]): Promise<CompactorInfoData> {
  try {
    const stats = sessionCompactionStats(branch);
    const pct = stats.tokensBefore > 0 ? Math.round((1 - stats.tokensAfter / stats.tokensBefore) * 100) : 0;
    const costPerToken = await estimateCostPerToken();
    const costSaved = costPerToken !== null ? stats.tokensSaved * costPerToken : null;
    const tools = [...stats.toolCalls.entries()].sort((a, b) => b[1] - a[1]);
    const last = getLastCompactionStats();
    const count = stats.compactions.length;
    return {
      tokensSaved: {
        value: formatTokens(stats.tokensSaved),
        detail: count > 0 ? `${count} compaction(s) this session` : "No compactions this session",
      },
      costSaved: {
        value: costSaved !== null ? formatCost(costSaved) : "N/A",
        detail: costSaved !== null
          ? `~${formatTokens(stats.tokensSaved)} tokens × $${(costPerToken! * 1_000_000).toFixed(2)}/M tokens`
          : "Cost data unavailable for current model",
      },
      pctReduction: {
        value: `${pct}%`,
        detail: stats.tokensBefore > 0
          ? `${formatTokens(stats.tokensBefore)} before → ${formatTokens(stats.tokensAfter)} after`
          : "No compaction data yet",
      },
      topTools: {
        value: tools[0] ? `${tools[0][0]}: ${tools[0][1]}` : "N/A",
        detail: tools.length > 0 ? tools.slice(0, 5).map(([n, c]) => `${n}: ${c}`).join("\n") : "No tool calls yet",
      },
      compactions: {
        value: String(count),
        detail: last ? `Last: ${formatCompactionStats(last)}` : count > 0 ? `${count} this session` : "No compactions yet",
      },
      toolCalls: {
        value: String(stats.totalToolCalls),
        detail: `${stats.totalToolCalls} calls across ${tools.length} tool${tools.length === 1 ? "" : "s"}`,
      },
    };
  } catch {
    return EMPTY;
  }
}
