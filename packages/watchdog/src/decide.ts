/**
 * @pi-unipi/watchdog — Decision logic (pure)
 *
 * Turns one jev answer set + the watchdog settings into either "no action"
 * (streak continues/starts) or an action with a human-readable reason.
 */

import type { JevAnswer } from "@pi-unipi/core";

export interface WatchdogDecision {
  /** true when the item is judged stuck/looping with enough confidence. */
  act: boolean;
  status: "progressing" | "waiting" | "stuck" | "looping" | "unknown";
  confidence: number;
  /** Consecutive agreeing checks including this one. */
  streak: number;
  /** Human-readable signal for the kill/warn reason. */
  signal: string;
  /** The item is a long-lived process — never kill (veto). */
  persistent: boolean;
}

const STATUSES = ["progressing", "waiting", "stuck", "looping"] as const;

/**
 * Evaluate one tick. `previousStreak` carries the count of consecutive
 * agreeing checks before this tick; jev null keeps the streak unchanged.
 */
export function evaluateTick(
  answers: Record<string, JevAnswer> | null,
  previousStreak: number,
  opts: { confidence: number },
): WatchdogDecision {
  if (!answers) {
    return {
      act: false, status: "unknown", confidence: 0,
      streak: previousStreak, signal: "", persistent: false,
    };
  }

  const rawStatus = answers.status?.choice;
  const status = (STATUSES as readonly string[]).includes(String(rawStatus))
    ? (rawStatus as WatchdogDecision["status"])
    : "unknown";
  const confidence = typeof answers.status?.confidence === "number" ? answers.status.confidence : 0;
  const persistent = typeof answers.persistent?.noul === "number" ? answers.persistent.noul >= 0.5 : false;

  const agrees =
    (status === "stuck" || status === "looping") && confidence >= opts.confidence && !persistent;
  const streak = agrees ? previousStreak + 1 : 0;

  return { act: agrees, status, confidence, streak, signal: statusSignal(status), persistent };
}

function statusSignal(status: WatchdogDecision["status"]): string {
  switch (status) {
    case "stuck": return "judged stuck";
    case "looping": return "repeating output without progress";
    default: return status;
  }
}
