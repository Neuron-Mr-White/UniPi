/**
 * Info-screen Compactor tab: the settings in force and this session's
 * compactions, read from the session branch.
 */

import { compactionSavings, formatTokens, type CompactionSaving, type SavingsTotals } from "@pi-unipi/core";
import { loadConfig } from "./config/manager.js";
import { methodBreakdown, sessionCompactionStats } from "./stats.js";

type Stat = { value: string; detail: string; raw?: unknown };

/** Structured payload for the info-screen Compactor page renderer. */
export interface CompactorPageRaw {
  method: string;
  trigger: string;
  piCompact: string;
  history: Array<{ before: number; after: number; method: string; at?: number }>;
  before: number;
  after: number;
  saved: number;
  /** This session's savings (tokens not re-sent + money). */
  session: SavingsTotals;
  /** Per-compaction savings for the timeline. */
  items: CompactionSaving[];
}

export interface CompactorInfoData {
  settings: Stat;
  compactions: Stat;
  tokens: Stat;
  last: Stat;
  raw: Stat;
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
  const raw: CompactorPageRaw = {
    method: METHOD_NAME[config.method],
    trigger: config.trigger === "pi" ? "at Pi's context limit" : `at ${config.thresholdPercent}% of context`,
    piCompact: config.piCompact === "follow" ? "same as method" : METHOD_NAME[config.piCompact],
    history: stats.compactions.slice(-24).map((c) => ({ before: c.tokensBefore, after: c.tokensAfter, method: METHOD_NAME[c.method] ?? c.method, at: c.at })),
    before: stats.tokensBefore,
    after: stats.tokensAfter,
    saved: stats.tokensSaved,
    ...(() => {
      const s = compactionSavings(branch);
      return { session: s.totals, items: s.items.slice(-24) };
    })(),
  };
  return {
    raw: { value: "", detail: "", raw },
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
