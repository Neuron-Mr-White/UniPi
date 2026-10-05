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


export interface BashCheckInput {
  ageSec: number; sinceOutputSec: number; command: string;
  sample: import("./proc-sample.js").ProcSample | null;
  prevIdle: boolean; prevCumulativeIo: number | null;
  stop: number | null; stopStreak: number;
  expect: "seconds" | "minutes" | "long" | "never" | "unknown";
  threshold: number; agreeChecks: number;
}
export interface BashDecision {
  act: boolean; idle: boolean; stopStreak: number; vetoed: boolean;
  trigger: "idle" | "stop" | "expect" | null; reason: string; cumulativeIo: number | null;
}
export function declaredBoundSec(command: string): number | null {
  const bounds: number[] = [];
  for (const regex of [/\btimeout\s+(\d+)([smh]?)/g, /\bsleep\s+(\d+)([smh]?)\s*(&&|;)/g]) {
    for (const match of command.matchAll(regex)) bounds.push(Number(match[1]) * (match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1));
  }
  for (const match of command.matchAll(/seq\s+\d+\s+(\d+).*?sleep\s+(\d+(?:\.\d+)?)/g)) bounds.push(Number(match[1])*Number(match[2]));
  return bounds.length ? Math.max(...bounds) : null;
}
const duration = (seconds: number) => seconds < 60 ? `${Math.round(seconds)}s` : `${Math.round(seconds/60)} min`;
export function decideBash(input: BashCheckInput): BashDecision {
  const { sample } = input, g=sample?.group_totals;
  const idle = !!g && g.cpu_pct < 2 && g.read_bytes+g.write_bytes+g.rchar+g.wchar < 4096 && input.sinceOutputSec >= 60
    && (input.prevCumulativeIo === null || sample!.cumulative_io-input.prevCumulativeIo < 4096);
  const sleeper=sample?.processes.some(p=>p.comm==="sleep" || p.wchan.includes("nanosleep")) ?? false;
  const stopStreak=input.stop!==null && input.stop>=input.threshold ? input.stopStreak+1 : 0;
  const bound=declaredBoundSec(input.command),vetoed=bound!==null && input.ageSec<bound;
  const trigger=idle && input.prevIdle && !sleeper ? "idle" : stopStreak>=input.agreeChecks ? "stop" : input.expect==="seconds" ? "expect" : null;
  const reason=trigger==="idle" ? `no CPU, disk or output activity for ${duration(input.sinceOutputSec)}`
    : trigger==="stop" ? `jev judged it unlikely to finish on its own (${input.stop!.toFixed(2)}, ${stopStreak} checks in a row)`
    : trigger==="expect" ? `jev expects this command to finish within seconds, but it has run for ${duration(input.ageSec)}` : "";
  return {act:!vetoed && trigger!==null,idle,stopStreak,vetoed,trigger,reason,cumulativeIo:sample?.cumulative_io ?? null};
}
