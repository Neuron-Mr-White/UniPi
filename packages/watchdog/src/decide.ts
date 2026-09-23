/**
 * @pi-unipi/watchdog — Decision logic (pure)
 *
 * Turns one jev answer set + the watchdog settings into either "no action"
 * (streak continues/starts) or an action with a human-readable reason.
 *
 * act = (status ∈ {stuck, looping})
 *     && confidence ≥ threshold
 *     && !(persistent ≥ 0.5 && status ≠ looping)
 *     && streak ≥ agreeChecks
 */

import type { JevAnswer } from "@pi-unipi/core";

export interface WatchdogDecision {
  /** true when all conditions are met (status + confidence + streak). */
  act: boolean;
  status: "progressing" | "waiting" | "stuck" | "looping" | "unknown";
  confidence: number;
  /** Consecutive agreeing checks including this one. */
  streak: number;
  /** Human-readable signal for the kill/warn reason. */
  signal: string;
  /** jev judged the process as long-lived (noul ≥ 0.5). */
  persistent: boolean;
  /** Streak meets the agreeChecks threshold. */
  enoughChecks: boolean;
}

const STATUSES = ["progressing", "waiting", "stuck", "looping"] as const;

/**
 * Evaluate one tick. `previousStreak` carries the count of consecutive
 * agreeing checks before this tick; jev null keeps the streak unchanged.
 */
export function evaluateTick(
  answers: Record<string, JevAnswer> | null,
  previousStreak: number,
  opts: { confidence: number; agreeChecks: number },
): WatchdogDecision {
  if (!answers) {
    return {
      act: false, status: "unknown", confidence: 0,
      streak: previousStreak, signal: "", persistent: false,
      enoughChecks: previousStreak >= opts.agreeChecks,
    };
  }

  const rawStatus = answers.status?.choice;
  const status = (STATUSES as readonly string[]).includes(String(rawStatus))
    ? (rawStatus as WatchdogDecision["status"])
    : "unknown";
  const confidence = typeof answers.status?.confidence === "number" ? answers.status.confidence : 0;
  const persistent = typeof answers.persistent?.noul === "number" ? answers.persistent.noul >= 0.5 : false;

  // Persistent veto: a long-lived service that is operating normally (not
  // looping with errors) is protected. A looping service with repeated errors
  // is NOT healthy — it gets killed even if it looks like a daemon.
  const veto = persistent && status !== "looping";
  const agrees =
    (status === "stuck" || status === "looping") && confidence >= opts.confidence && !veto;
  const streak = agrees ? previousStreak + 1 : 0;
  const enoughChecks = streak >= opts.agreeChecks;

  return { act: agrees && enoughChecks, status, confidence, streak, signal: statusSignal(status), persistent, enoughChecks };
}

function statusSignal(status: WatchdogDecision["status"]): string {
  switch (status) {
    case "stuck": return "judged stuck";
    case "looping": return "repeating output without progress";
    default: return status;
  }
}
