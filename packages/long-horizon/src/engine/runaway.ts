/**
 * Runaway guard — within-turn loop detection with steer-once nudges.
 *
 * mcode's six detectors over step views, adapted to pi's tool_execution_end:
 *   exact_action_repeat       same {tool, input} ≥ remindAfter times
 *   exact_result_repeat       same result text ≥ remindAfter times
 *   same_error_family         same normalized error ≥ remindAfter times
 *   polling_repeat            status-inspection tools called with no work
 *                             between them ≥ remindAfter times
 *   unchanged_progress_repeat identical action AND identical result
 *   abab_action_cycle         A,B,A,B two-step cycle
 *
 * Response is STEER, not kill: one nudge per turn, priority-ordered, with
 * anti-poisoning text (mcode verbatim intent): the reminder is turn-scoped
 * and must never be saved into memory, skills, or other persistent files.
 *
 * Design: docs/long-horizon-design.md §5; study §5.
 */

import { createHash } from "node:crypto";

export const RUNAWAY_SIGNALS = [
  "exact_action_repeat",
  "abab_action_cycle",
  "unchanged_progress_repeat",
  "same_error_family",
  "exact_result_repeat",
  "polling_repeat",
] as const;

export type RunawaySignal = (typeof RUNAWAY_SIGNALS)[number];

/** Priority order for the single nudge a turn may receive. */
export const REMINDER_CANDIDATE_PRIORITY: readonly RunawaySignal[] = [
  "exact_action_repeat",
  "abab_action_cycle",
  "unchanged_progress_repeat",
  "same_error_family",
  "exact_result_repeat",
  "polling_repeat",
];

export const DEFAULT_REMIND_AFTER = 3;
export const MAX_ABAB_WINDOW = 8;

export const ANTI_POISONING_SUFFIX =
  "This is a temporary runtime reminder for the current Turn only, not a user preference " +
  "or a durable rule; do not save this reminder or generalize it into Memory, Skills, or " +
  "other persistent instruction files.";

/** Tools whose repetition with varying args indicates polling, not work. */
const POLLING_TOOLS = new Set(["bg_status", "bg_logs", "get_helper_result", "loop_status", "get_goal"]);

export interface RunawayStep {
  readonly tool: string;
  readonly input: unknown;
  readonly resultText: string;
  readonly isError: boolean;
}

export interface RunawayGuardDeps {
  /** Deliver the steer message (pi.sendUserMessage with deliverAs "steer"). */
  steer(text: string): void;
  remindAfter?: number;
}

function fingerprint(value: unknown): string {
  const json = (() => {
    try {
      return JSON.stringify(value ?? null);
    } catch {
      return String(value);
    }
  })();
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** Errors normalize to their family: first line, digits and paths removed. */
export function errorFamily(text: string): string {
  return text
    .split("\n")[0]
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/\d+/g, "N")
    .slice(0, 160)
    .trim();
}

export interface RunawayObservation {
  readonly signal: RunawaySignal;
  readonly occurrences: number;
  readonly tool: string;
}

/** Pure detector: returns the highest-priority qualifying signal, if any. */
export function detectRunaway(
  steps: readonly RunawayStep[],
  remindAfter: number = DEFAULT_REMIND_AFTER,
): RunawayObservation | null {
  if (steps.length < remindAfter) return null;

  const actionKeys = steps.map((step) => `${step.tool}:${fingerprint(step.input)}`);
  const resultKeys = steps.map((step) => fingerprint(step.resultText.slice(0, 400)));
  const errorKeys = steps.map((step) => (step.isError ? errorFamily(step.resultText) : null));

  const count = (keys: readonly string[]): { key: string; count: number } => {
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    let best = { key: "", count: 0 };
    for (const [key, value] of counts) if (value > best.count) best = { key, count: value };
    return best;
  };

  const actions = count(actionKeys);
  if (actions.count >= remindAfter) {
    const actionIndex = actionKeys.lastIndexOf(actions.key);
    const step = steps[actionIndex];
    const results = count(resultKeys);
    return {
      signal:
        results.count >= remindAfter && results.key === resultKeys[actionIndex]
          ? "unchanged_progress_repeat"
          : "exact_action_repeat",
      occurrences: actions.count,
      tool: step.tool,
    };
  }

  // ABAB: alternating two distinct actions, each ≥ remindAfter - 1, no other action.
  const tail = steps.slice(-MAX_ABAB_WINDOW);
  if (tail.length >= 4) {
    const keys = tail.map((step) => `${step.tool}:${fingerprint(step.input)}`);
    const distinct = new Set(keys);
    if (distinct.size === 2) {
      const [a, b] = [...distinct];
      const alternates = keys.every((key, index) => key === (index % 2 === 0 ? a : b)) ||
        keys.every((key, index) => key === (index % 2 === 0 ? b : a));
      const aCount = keys.filter((k) => k === a).length;
      const bCount = keys.filter((k) => k === b).length;
      if (alternates && aCount >= remindAfter - 1 && bCount >= remindAfter - 1) {
        return { signal: "abab_action_cycle", occurrences: Math.min(aCount, bCount) * 2, tool: tail[0].tool };
      }
    }
  }

  const errors = count(errorKeys.filter((key): key is string => key !== null));
  if (errors.count >= remindAfter) {
    const index = errorKeys.findIndex((key) => key === errors.key);
    return { signal: "same_error_family", occurrences: errors.count, tool: steps[index].tool };
  }

  const results = count(resultKeys);
  if (results.count >= remindAfter) {
    const index = resultKeys.lastIndexOf(results.key);
    return { signal: "exact_result_repeat", occurrences: results.count, tool: steps[index].tool };
  }

  // Polling: status tools dominating recent steps with varying inputs.
  const recent = steps.slice(-(remindAfter + 2));
  const polling = recent.filter((step) => POLLING_TOOLS.has(step.tool));
  if (polling.length >= remindAfter) {
    return { signal: "polling_repeat", occurrences: polling.length, tool: polling[0].tool };
  }

  return null;
}

export function runawayNudgeText(signal: RunawaySignal, occurrences: number): string {
  const guidance: Record<RunawaySignal, string> = {
    exact_action_repeat:
      `The same action has now run ${occurrences} times with identical arguments. Repetition is not progress: ` +
      "inspect the current state, change the approach, or surface the blocker to the user.",
    abab_action_cycle:
      `Two actions are alternating in a loop (${occurrences} steps seen). Break the cycle: pick a materially ` +
      "different next action that changes the state you are operating on.",
    unchanged_progress_repeat:
      "Actions are repeating and producing identical results. Nothing is changing. Re-inspect the actual " +
      "artifact or state, adjust the plan, or explain the blocker instead of retrying.",
    same_error_family:
      `The same error family has occurred ${occurrences} times. Do not retry the failing call unchanged: ` +
      "read the error, change the inputs or approach, or ask for help with the specific blocker.",
    exact_result_repeat:
      `Identical results have returned ${occurrences} times. Treat the state as stable and act on it ` +
      "rather than re-checking.",
    polling_repeat:
      "Status-checking tools dominate recent steps. Polling does not advance the work: take an action " +
      "that changes state, or end the turn and let the wake notification resume you.",
  };
  return `No-progress guard: ${guidance[signal]} ${ANTI_POISONING_SUFFIX}`;
}

/**
 * Turn-scoped guard. Feed it every step; it steers at most once per turn,
 * reserving the attempt BEFORE delivering so a failed steer never retries.
 */
export class RunawayGuard {
  private steps: RunawayStep[] = [];
  private steerAttempted = false;
  private readonly deps: RunawayGuardDeps;

  constructor(deps: RunawayGuardDeps) {
    this.deps = deps;
  }

  feed(step: RunawayStep): RunawayObservation | null {
    this.steps.push(step);
    if (this.steerAttempted) return null;
    const observation = detectRunaway(this.steps, this.deps.remindAfter ?? DEFAULT_REMIND_AFTER);
    if (!observation) return null;
    this.steerAttempted = true;
    this.deps.steer(runawayNudgeText(observation.signal, observation.occurrences));
    return observation;
  }

  /** Turn boundary: forget steps, allow one fresh steer next turn. */
  resetTurn(): void {
    this.steps = [];
    this.steerAttempted = false;
  }
}
