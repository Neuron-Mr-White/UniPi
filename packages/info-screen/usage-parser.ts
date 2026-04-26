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
  // Replicate Pi's logic: respect PI_CODING_AGENT_DIR env var
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "sessions");
}

/**
 * Get period boundaries for today, this week, this month.
 * Today starts at 00:00 local time.
 * Week starts on Monday.
 */
function getPeriodBounds(): { today: PeriodBounds; week: PeriodBounds; month: PeriodBounds } {
  const now = new Date();

  // Start of today (midnight local time)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  // Start of current week (Monday 00:00)
  const weekStart = new Date(now);
  const dayOfWeek = weekStart.getDay(); // 0 = Sunday, 1 = Monday, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  weekStart.setDate(weekStart.getDate() - daysSinceMonday);
  weekStart.setHours(0, 0, 0, 0);

  // Start of current month (1st day 00:00)
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    today: { start: todayStart, end: now },
    week: { start: weekStart, end: now },
    month: { start: monthStart, end: now },
  };
}



/**
 * Parse a JSONL session file and extract usage data.
 * Matches tmustier's parsing logic.
 */
function parseSessionFile(
  filePath: string,
  seenHashes: Set<string>
): Array<{ usage: MessageUsage; model: string; timestamp: number }> {
  const results: Array<{ usage: MessageUsage; model: string; timestamp: number }> = [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // Match tmustier's parsing: check entry.type === "message" and entry.message?.role === "assistant"
        if (entry.type === "message" && entry.message?.role === "assistant") {
          const msg = entry.message;
          if (msg.usage && msg.provider && msg.model) {
            const input = msg.usage.input || 0;
            const output = msg.usage.output || 0;
            const cacheRead = msg.usage.cacheRead || 0;
            const cacheWrite = msg.usage.cacheWrite || 0;
            const cost = msg.usage.cost?.total || 0;

            // Get timestamp
            const fallbackTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
            const timestamp = msg.timestamp || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);

            // Deduplicate copied history across branched session files
            const totalTokens = input + output + cacheRead + cacheWrite;
            const hash = `${timestamp}:${totalTokens}`;
            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);

            // Only include if we have valid data
            if (input > 0 || output > 0 || cost > 0) {
              results.push({
                usage: {
                  input,
                  output,
                  cacheRead,
                  cacheWrite,
                  cost: { total: cost },
                },
                model: msg.model,
                timestamp,
              });
            }
          }
        }
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
 * Collect all session files recursively.
 */
function collectSessionFiles(dir: string, files: string[]): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSessionFiles(entryPath, files);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

/**
 * Parse all session files and aggregate usage stats.
 * Matches tmustier's parsing logic.
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
  const seenHashes = new Set<string>();

  // Collect all session files recursively
  const sessionFiles: string[] = [];
  collectSessionFiles(sessionsDir, sessionFiles);
  sessionFiles.sort();

  for (const filePath of sessionFiles) {
    const messages = parseSessionFile(filePath, seenHashes);

    if (messages.length === 0) continue;

    stats.sessionCount++;
    stats.messageCount += messages.length;

    for (const msg of messages) {
      // Match tmustier's token calculation: input + output + cacheWrite (not cacheRead)
      const totalTokens = msg.usage.input + msg.usage.output + msg.usage.cacheWrite;

      // All time
      stats.tokens.allTime += totalTokens;
      stats.cost.allTime += msg.usage.cost.total;

      // Today
      if (msg.timestamp >= periods.today.start.getTime()) {
        stats.tokens.today += totalTokens;
        stats.cost.today += msg.usage.cost.total;
      }

      // This week
      if (msg.timestamp >= periods.week.start.getTime()) {
        stats.tokens.week += totalTokens;
        stats.cost.week += msg.usage.cost.total;
      }

      // This month
      if (msg.timestamp >= periods.month.start.getTime()) {
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
