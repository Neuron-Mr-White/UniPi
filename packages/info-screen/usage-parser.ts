/**
 * @pi-unipi/info-screen — Session file parser
 *
 * Parses ~/.pi/agent/sessions/ JSONL files for usage stats.
 * Reference: tmustier/pi-extensions/usage-extension
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

/** Usage data for a single message */
interface MessageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** Aggregated usage stats */
export interface UsageStats {
  /** Total tokens by period */
  tokens: {
    today: number;
    week: number;
    month: number;
    allTime: number;
  };
  /** Total cost by period (USD) */
  cost: {
    today: number;
    week: number;
    month: number;
    allTime: number;
  };
  /** Token counts by model */
  byModel: Record<string, { tokens: number; cost: number; sessions: number }>;
  /** Total sessions */
  sessionCount: number;
  /** Total messages */
  messageCount: number;
}

/** Time period boundaries */
interface PeriodBounds {
  start: Date;
  end: Date;
}

/**
 * Get the sessions directory path.
 */
function getSessionsDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  return join(homeDir, ".pi", "agent", "sessions");
}

/**
 * Get period boundaries for today, this week, this month.
 */
function getPeriodBounds(): { today: PeriodBounds; week: PeriodBounds; month: PeriodBounds } {
  const now = new Date();

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    today: { start: todayStart, end: now },
    week: { start: weekStart, end: now },
    month: { start: monthStart, end: now },
  };
}

/**
 * Check if a timestamp falls within a period.
 */
function isInPeriod(timestamp: Date, period: PeriodBounds): boolean {
  return timestamp >= period.start && timestamp <= period.end;
}

/**
 * Parse a JSONL session file and extract usage data.
 */
function parseSessionFile(filePath: string): Array<{ usage: MessageUsage; model: string; timestamp: Date }> {
  const results: Array<{ usage: MessageUsage; model: string; timestamp: Date }> = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);

        // Only process assistant messages with usage data
        if (entry.role !== "assistant" || !entry.usage) continue;

        const usage = entry.usage;
        if (typeof usage.input !== "number" || typeof usage.output !== "number") continue;
        if (!usage.cost || typeof usage.cost.total !== "number") continue;

        results.push({
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead ?? 0,
            cacheWrite: usage.cacheWrite ?? 0,
            cost: { total: usage.cost.total },
          },
          model: entry.model ?? "unknown",
          timestamp: new Date(entry.timestamp ?? Date.now()),
        });
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Skip unreadable files
  }

  return results;
}

/**
 * Parse all session files and aggregate usage stats.
 */
export function parseUsageStats(): UsageStats {
  const sessionsDir = getSessionsDir();
  const stats: UsageStats = {
    tokens: { today: 0, week: 0, month: 0, allTime: 0 },
    cost: { today: 0, week: 0, month: 0, allTime: 0 },
    byModel: {},
    sessionCount: 0,
    messageCount: 0,
  };

  if (!existsSync(sessionsDir)) return stats;

  const periods = getPeriodBounds();

  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip directories (subagent runs)
      if (entry.isDirectory()) continue;

      // Only process .jsonl files
      if (!entry.name.endsWith(".jsonl")) continue;

      const filePath = join(sessionsDir, entry.name);
      const messages = parseSessionFile(filePath);

      if (messages.length === 0) continue;

      stats.sessionCount++;
      stats.messageCount += messages.length;

      for (const msg of messages) {
        const totalTokens = msg.usage.input + msg.usage.output + msg.usage.cacheWrite;

        // All time
        stats.tokens.allTime += totalTokens;
        stats.cost.allTime += msg.usage.cost.total;

        // Today
        if (isInPeriod(msg.timestamp, periods.today)) {
          stats.tokens.today += totalTokens;
          stats.cost.today += msg.usage.cost.total;
        }

        // This week
        if (isInPeriod(msg.timestamp, periods.week)) {
          stats.tokens.week += totalTokens;
          stats.cost.week += msg.usage.cost.total;
        }

        // This month
        if (isInPeriod(msg.timestamp, periods.month)) {
          stats.tokens.month += totalTokens;
          stats.cost.month += msg.usage.cost.total;
        }

        // By model
        const model = msg.model;
        if (!stats.byModel[model]) {
          stats.byModel[model] = { tokens: 0, cost: 0, sessions: 0 };
        }
        stats.byModel[model].tokens += totalTokens;
        stats.byModel[model].cost += msg.usage.cost.total;
        stats.byModel[model].sessions++;
      }
    }
  } catch {
    // Return empty stats on error
  }

  return stats;
}

/**
 * Format token count for display.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
  return `${Math.round(n / 1000000)}M`;
}

/**
 * Format cost for display.
 */
export function formatCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(2)}`;
}
