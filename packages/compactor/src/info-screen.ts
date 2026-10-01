/**
 * Info-screen Compactor tab: the settings in force and this session's
 * compactions, read from the session branch.
 */

import { formatTokens } from "@pi-unipi/core";
import { loadConfig } from "./config/manager.js";
import { methodBreakdown, sessionCompactionStats } from "./stats.js";

type Stat = { value: string; detail: string };

export interface CompactorInfoData {
  settings: Stat;
  compactions: Stat;
  tokens: Stat;
  last: Stat;
}

const METHOD_NAME = { vcc: "lossless", llm: "model summary" } as const;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function getInfoScreenData(branch: readonly any[], cwd: string = process.cwd(), now = Date.now()): CompactorInfoData {
  const config = loadConfig(cwd);
  const stats = sessionCompactionStats(branch);
  const count = stats.compactions.length;
  const last = stats.compactions[count - 1];
  const pct = stats.tokensBefore > 0 ? Math.round((stats.tokensSaved / stats.tokensBefore) * 100) : 0;
  return {
    settings: {
      value: METHOD_NAME[config.method],
      detail: `when: ${config.trigger === "pi" ? "Pi's context limit" : `${config.thresholdPercent}% of context`} · Pi's /compact: ${config.piCompact === "follow" ? "same as method" : METHOD_NAME[config.piCompact]}`,
    },
    compactions: {
      value: String(count),
      detail: count > 0 ? methodBreakdown(stats) : "none this session",
    },
    tokens: {
      value: count > 0 ? `${formatTokens(stats.tokensBefore)} → ${formatTokens(stats.tokensAfter)}` : "—",
      detail: count > 0 ? `−${formatTokens(stats.tokensSaved)} (${pct}%) across all compactions` : "nothing compacted yet",
    },
    last: {
      value: last ? `${formatTokens(last.tokensBefore)} → ${formatTokens(last.tokensAfter)}` : "—",
      detail: last
        ? [METHOD_NAME[last.method], last.jevDropped ? `${last.jevDropped} stale dropped` : "", last.at ? ago(now - last.at) : ""].filter(Boolean).join(" · ")
        : "no compaction yet",
    },
  };
}
