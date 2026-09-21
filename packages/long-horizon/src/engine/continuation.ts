/**
 * Goal continuation coordinator — turn-end settlement and the next turn.
 *
 *   turn ends → drain proposals → verify claims → settle →
 *     active   → send one-line hint (or nudge / scheduled audit)
 *     waiting  → exponential backoff 5s×2ⁿ cap 5min → wake → hint
 *     paused   → owner finished with reason (resumable)
 *     terminal → owner finished; budget_limited delivers a wrap-up turn once
 *
 * All messaging rides tail messages (kickoff once, then one-liners) — the
 * system-prompt fragment stays static per mode (prefix-cache discipline).
 * Design: docs/long-horizon-design.md §4; study §4.
 */

import type { GoalMachine, GoalState } from "./goal-state.js";
import type { GoalToolset } from "../tools/goal.js";
import {
  assembleEvidenceBrief,
  verifyCompletion,
  type EvidenceBriefInput,
  type VerificationVerdict,
  type VerifierDeps,
} from "./verifier.js";
import {
  AUDIT_EVERY_N_TURNS,
  NO_PROGRESS_NUDGE,
  NO_TOOL_NUDGE,
  RECOVERY_FRAGMENT,
  TERMINAL_AUDIT,
  WRAP_UP_PROMPT,
  renderContinuationHint,
  renderKickoff,
} from "../prompts/goal.js";
import type { OwnerCoordinator } from "../owner.js";

export const WAIT_BACKOFF_BASE_MS = 5_000;
export const WAIT_BACKOFF_MAX_MS = 5 * 60_000;

export interface TurnActivity {
  /** Tool calls made this turn (0 → NO_TOOL_NUDGE candidate). */
  readonly toolCalls: number;
  /** Files touched this turn (edit/write) for the evidence brief. */
  readonly changedFiles: readonly string[];
  /** Commands run this turn (bash) for the evidence brief. */
  readonly commands: readonly string[];
  /** Recent conversation tail for the evidence brief. */
  readonly recentTail: readonly { readonly role: string; readonly text: string }[];
  /** Worker/host signal: the turn is blocked on an external event (CI, deploy). */
  readonly waiting?: boolean;
}

export interface ContinuationDeps {
  readonly machine: GoalMachine;
  readonly toolset: GoalToolset;
  readonly owner: OwnerCoordinator;
  /** Verifier wiring; defaults to a VerifierDeps the caller provides. */
  readonly verifier: VerifierDeps;
  /** Deliver a continuation/kickoff/wrap-up message (tail message). */
  send(message: string): void;
  getTokenCount?(): number | undefined;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): void;
}

export type ContinuationDecision =
  | { action: "none"; reason: "no-active-goal" | "kickoff-delivered" }
  | { action: "continue"; via: "hint" | "nudge-no-progress" | "nudge-no-tool" | "terminal-audit" | "recovery" }
  | { action: "wait"; delayMs: number }
  | { action: "stopped"; terminal: string; wrapUp: boolean };

export function waitBackoffMs(consecutiveWaits: number): number {
  return Math.min(WAIT_BACKOFF_MAX_MS, WAIT_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveWaits - 1));
}

/** Which hint variant the next continuation should use. */
export function selectHint(
  goal: GoalState,
  activity: TurnActivity,
  recovery: boolean,
): "hint" | "nudge-no-progress" | "nudge-no-tool" | "terminal-audit" | "recovery" {
  if (recovery) return "recovery";
  if (activity.toolCalls === 0) return "nudge-no-tool";
  if (goal.noProgressStreak > 0 && activity.toolCalls === 0) return "nudge-no-tool";
  if (goal.noProgressStreak >= 2) return "nudge-no-progress";
  if (goal.turn > 0 && goal.turn % AUDIT_EVERY_N_TURNS === 0) return "terminal-audit";
  return "hint";
}

export class GoalContinuation {
  private consecutiveWaits = 0;
  private lastVerifierReason?: string;
  private recoveryArmed = false;
  private readonly deps: ContinuationDeps;
  private tokenCounter?: () => number | undefined;
  private evaluateOverride?: VerifierDeps["evaluate"];

  constructor(deps: ContinuationDeps) {
    this.deps = deps;
  }

  /** Late-bound token counter (runtime wiring sets it per agent_end). */
  setTokenCounter(counter: () => number | undefined): void {
    this.tokenCounter = counter;
  }

  /** Late-bound evaluator (runtime wiring resolves the model per session). */
  setEvaluate(evaluate: VerifierDeps["evaluate"]): void {
    this.evaluateOverride = evaluate;
  }

  /** Crash/interrupt marker: the next continuation carries the recovery fragment. */
  armRecovery(): void {
    this.recoveryArmed = true;
  }

  /** Deliver the kickoff contract once for a fresh goal (cache-stable). */
  deliverKickoff(goal: GoalState): void {
    this.deps.send(renderKickoff(goal.objective));
    this.deps.machine.markKickoffDelivered(goal.goalId);
    this.consecutiveWaits = 0;
    this.lastVerifierReason = undefined;
  }

  /**
   * Turn-end settlement. Returns the decision; side effects are messages,
   * timers, and owner lifecycle.
   */
  async onTurnEnd(activity: TurnActivity): Promise<ContinuationDecision> {
    const machine = this.deps.machine;
    const goal = machine.getActive();
    if (!goal) return { action: "none", reason: "no-active-goal" };

    // Kickoff not yet delivered (e.g., goal created mid-turn): contract first.
    if (!goal.kickoffDelivered) {
      this.deliverKickoff(goal);
      return { action: "none", reason: "kickoff-delivered" };
    }

    const proposal = this.deps.toolset.consumeProposal();
    const tokensNow = this.tokenCounter?.() ?? this.deps.getTokenCount?.();

    let settled: GoalState | undefined;
    if (proposal?.kind === "completion") {
      const brief = assembleEvidenceBrief({
        objective: goal.objective,
        objectiveDigest: goal.objectiveDigest,
        ...(proposal.summary !== undefined ? { claim: proposal.summary } : {}),
        changedFiles: activity.changedFiles,
        commands: activity.commands,
        recentTail: activity.recentTail,
      });
      const verdict = await verifyCompletion(
        { ...this.deps.verifier, ...(this.evaluateOverride ? { evaluate: this.evaluateOverride } : {}) },
        goal.objective,
        brief,
      );
      this.lastVerifierReason = verdict.evaluatorFailed
        ? undefined
        : `${verdict.reason}${verdict.missing.length > 0 ? ` (missing: ${verdict.missing.join("; ")})` : ""}`;
      settled = machine.settleTurn({
        goalId: goal.goalId,
        revision: goal.revision,
        completionClaim: { ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}) },
        verifier: { verdict: verdict.verdict, ...(verdict.missing.length > 0 ? { missing: verdict.missing } : {}) },
        // A rejected claim is no progress; a met claim completed above; an
        // inconclusive/failed verifier is neutral (undefined).
        madeProgress: verdict.verdict === "not_met" ? false : undefined,
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    } else if (proposal?.kind === "blocked") {
      settled = machine.settleTurn({
        goalId: goal.goalId,
        revision: goal.revision,
        blockedProposal: true,
        ...(proposal.safetyRefusal ? { safetyRefusal: true } : {}),
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    } else {
      settled = machine.settleTurn({
        goalId: goal.goalId,
        revision: goal.revision,
        // v1 progress heuristic: any tool activity counts as attempted
        // progress; zero tools is neutral, not negative (the nudge handles it).
        madeProgress: activity.toolCalls > 0 ? true : undefined,
        ...(activity.waiting ? { waiting: true } : {}),
        ...(tokensNow !== undefined ? { tokensNow } : {}),
      });
    }

    if (!settled) {
      // CAS miss or race: stay quiet this turn, retry next.
      return { action: "none", reason: "no-active-goal" };
    }

    // Terminal / paused → stop the owner; budget_limited adds a wrap-up turn.
    if (settled.status !== "active" && settled.status !== "waiting") {
      const terminal = settled.reason ?? settled.status;
      const wrapUp = settled.status === "budget_limited" && !machine.isWrapUpDelivered(settled);
      if (wrapUp) machine.markWrapUpDelivered(settled.goalId, settled.revision);
      this.deps.owner.finish(terminal);
      if (wrapUp) this.deps.send(WRAP_UP_PROMPT);
      return { action: "stopped", terminal, wrapUp };
    }

    // Waiting: schedule the wake with exponential backoff.
    if (settled.status === "waiting") {
      this.consecutiveWaits += 1;
      const delayMs = waitBackoffMs(this.consecutiveWaits);
      this.deps.schedule?.(() => {
        const woken = this.deps.machine.wakeWaiting();
        if (woken) {
          this.consecutiveWaits = 0;
          this.deps.send(renderContinuationHint(woken));
        }
      }, delayMs);
      return { action: "wait", delayMs };
    }

    this.consecutiveWaits = 0;
    const hintKind = selectHint(settled, activity, this.recoveryArmed);
    this.recoveryArmed = false;
    switch (hintKind) {
      case "recovery":
        this.deps.send(RECOVERY_FRAGMENT);
        break;
      case "nudge-no-tool":
        this.deps.send(NO_TOOL_NUDGE);
        break;
      case "nudge-no-progress":
        this.deps.send(NO_PROGRESS_NUDGE);
        break;
      case "terminal-audit":
        this.deps.send(TERMINAL_AUDIT);
        break;
      default:
        this.deps.send(renderContinuationHint(settled, this.lastVerifierReason));
    }
    return { action: "continue", via: hintKind };
  }
}
