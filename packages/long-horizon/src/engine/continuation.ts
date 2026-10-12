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
import {
  attachTaskReminder,
  GoalTaskGatePolicy,
  type GoalTaskGateDecision,
  type GoalTaskGateDeps,
} from "./task-gate.js";

export const WAIT_BACKOFF_BASE_MS = 5_000;
export const WAIT_BACKOFF_MAX_MS = 5 * 60_000;
/**
 * Restart re-deliveries of one durable pending continuation before the goal
 * is paused as `paused(recovery_exhausted)` (bounded crash recovery).
 */
export const MAX_RECOVERY_REDELIVERIES = 2;

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
  /**
   * The turn was aborted by the user (Esc). The settlement still runs, but the
   * next prompt is NOT persisted as a pending continuation — a restart must
   * not re-drive a goal the user just interrupted.
   */
  readonly aborted?: boolean;
}

export interface ContinuationDeps {
  readonly machine: GoalMachine;
  readonly toolset: GoalToolset;
  readonly owner: OwnerCoordinator;
  /** Verifier wiring; defaults to a VerifierDeps the caller provides. */
  readonly verifier: VerifierDeps;
  /**
   * Deliver a continuation/kickoff/wrap-up message. Messages go to the
   * arbiter's nudge stash (long-horizon/index.ts), NOT the message queue;
   * `kind: "kickoff"` marks the kickoff contract, which is never overwritten
   * while undelivered.
   */
  send(message: string, kind?: "kickoff"): void;
  /**
   * Direct delivery for TIMER wakes while idle (waiting-backoff): an event,
   * not a nudge — bypasses the stash and prompts immediately.
   */
  sendNow?(message: string): void;
  /** User-only notification (wired to ctx.ui.notify at agent_end; optional in tests). */
  notify?(text: string, level?: "info" | "warning" | "error"): void;
  /** Kanboard claims reminder appended to continuation messages (UNI-123b);
   *  null/empty when the board is clean. Never rides kickoff/wrap-up/wakes. */
  boardLine?(): string | null;
  /**
   * Session todo list for the task gate (Maka GoalTaskGatePolicy): pending /
   * in_progress items turn a completion claim into a bounded "[Task reminder]"
   * continuation instead of a verifier run.
   */
  taskGate?: GoalTaskGateDeps;
  /** Best-effort task-gate decision trace (Maka recordDecision). */
  onTaskGateDecision?(trace: { goalId: string; decision: GoalTaskGateDecision; tasks: readonly string[] }): void;
  getTokenCount?(): number | undefined;
  now?(): number;
  schedule?(callback: () => void, delayMs: number): void;
}

/** What session_start recovery decided for a restored goal. */
export type RestartRecovery =
  /** A durable pending continuation exists: deliver `text` now (attempt recorded). */
  | { action: "redeliver"; text: string; attempt: number }
  /** No pending prompt: the recovery fragment rides the next continuation. */
  | { action: "armed" }
  /** Re-delivery budget spent: the goal was paused. */
  | { action: "exhausted"; attempts: number }
  | { action: "none" };

export type ContinuationDecision =
  | { action: "none"; reason: "no-active-goal" | "kickoff-delivered" }
  | { action: "continue"; via: "hint" | "nudge-no-progress" | "nudge-no-tool" | "terminal-audit" | "recovery" | "task-reminder" }
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
  private readonly taskGate: GoalTaskGatePolicy;

  constructor(deps: ContinuationDeps) {
    this.deps = deps;
    this.taskGate = new GoalTaskGatePolicy(deps.taskGate);
  }

  private traceTaskGate(goalId: string, decision: GoalTaskGateDecision, tasks: readonly string[]): void {
    try {
      this.deps.onTaskGateDecision?.({ goalId, decision, tasks });
    } catch {
      // Tracing is best-effort (Maka).
    }
  }

  /**
   * Persist-then-deliver (Maka durable continuation outbox): the prompt lands
   * in goal.json as `pendingContinuation` BEFORE it reaches the nudge stash /
   * sendNow. index.ts clears it once the turn it starts begins.
   */
  private deliver(goalId: string, message: string, options: { kind?: "kickoff"; direct?: boolean; persist?: boolean } = {}): void {
    if (options.persist !== false) {
      try {
        this.deps.machine.recordPendingContinuation(goalId, message);
      } catch {
        // A failed outbox write must never block delivery.
      }
    }
    if (options.direct) (this.deps.sendNow ?? this.deps.send)(message);
    else if (options.kind) this.deps.send(message, options.kind);
    else this.deps.send(message);
  }

  /**
   * session_start recovery for a restored goal (extends the recovery-fragment
   * path). A durable pending continuation is re-delivered — prefixed with the
   * recovery fragment — at most MAX_RECOVERY_REDELIVERIES times; after that
   * the goal pauses as `paused(recovery_exhausted)`. Without one, the
   * recovery fragment is armed for the next continuation (unchanged).
   * The caller delivers `text` (sendNow, outside any turn).
   */
  recoverOnRestart(): RestartRecovery {
    const machine = this.deps.machine;
    const goal = machine.get();
    if (!goal || (goal.status !== "active" && goal.status !== "waiting")) return { action: "none" };
    const pending = goal.pendingContinuation;
    // Only an owner that actually drives the goal (goal / ralph-loop, active,
    // not parked) may be re-driven; otherwise the outbox entry is stale.
    const driver = this.deps.owner.getActive();
    if (pending && (!driver || (driver.kind !== "goal" && driver.kind !== "ralph-loop"))) {
      machine.clearPendingContinuation();
      this.armRecovery();
      return { action: "armed" };
    }
    if (!pending) {
      this.armRecovery();
      return { action: "armed" };
    }
    if (pending.attempts >= MAX_RECOVERY_REDELIVERIES) {
      const reason = "paused(recovery_exhausted)" as const;
      const paused = machine.pause(reason);
      const active = this.deps.owner.getActive();
      if (paused && active && (active.kind === "goal" || active.kind === "ralph-loop")) {
        if (!this.deps.owner.suspend(reason)) this.deps.owner.finish(reason);
      }
      this.recoveryArmed = false;
      this.inform(
        `Goal continuation could not be re-delivered after ${pending.attempts} restarts — goal paused. /unipi:goal resume to continue.`,
      );
      return { action: "exhausted", attempts: pending.attempts };
    }
    // A waiting goal's wake timer died with the process: wake it now.
    const current = goal.status === "waiting" ? (machine.wakeWaiting() ?? goal) : goal;
    const text = pending.text.startsWith(RECOVERY_FRAGMENT) ? pending.text : `${RECOVERY_FRAGMENT}\n\n${pending.text}`;
    const attempt = pending.attempts + 1;
    machine.recordPendingContinuation(current.goalId, text, attempt);
    // The fragment rides this prompt; don't repeat it on the next hint.
    this.recoveryArmed = false;
    return { action: "redeliver", text, attempt };
  }

  /** Late-bound token counter (runtime wiring sets it per agent_end). */
  setTokenCounter(counter: () => number | undefined): void {
    this.tokenCounter = counter;
  }

  /** Late-bound evaluator (runtime wiring resolves the model per session). */
  setEvaluate(evaluate: VerifierDeps["evaluate"]): void {
    this.evaluateOverride = evaluate;
  }

  private tokensEstimated = false;
  private notifyOverride?: NonNullable<ContinuationDeps["notify"]>;

  /** Late-bound: the last turn's tokens were estimated, not read from usage. */
  setTokensEstimated(estimated: boolean): void {
    this.tokensEstimated = estimated;
  }

  /** Late-bound user notification (ctx.ui.notify at agent_end). */
  setNotify(notify: NonNullable<ContinuationDeps["notify"]>): void {
    this.notifyOverride = notify;
  }

  private inform(text: string, level: "info" | "warning" | "error" = "warning"): void {
    (this.notifyOverride ?? this.deps.notify)?.(text, level);
  }

  /** Crash/interrupt marker: the next continuation carries the recovery fragment. */
  armRecovery(): void {
    this.recoveryArmed = true;
  }

  /** Deliver the kickoff contract once for a fresh goal (cache-stable). */
  deliverKickoff(goal: GoalState): void {
    // Mark first: the transition would otherwise drop the outbox entry.
    this.deps.machine.markKickoffDelivered(goal.goalId);
    this.deliver(goal.goalId, renderKickoff(goal.objective), { kind: "kickoff" });
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
    if (!goal) {
      // No drivable goal: a pending proposal could never be settled — drop it
      // so get_goal stops advertising "verification pending" forever.
      this.deps.toolset.discardProposal();
      return { action: "none", reason: "no-active-goal" };
    }

    // Kickoff not yet delivered (e.g., goal created mid-turn): contract first.
    // The kickoff turn never settles — a proposal made beside creation is
    // stale by definition; discard it instead of letting it outlive the turn.
    if (!goal.kickoffDelivered) {
      this.deliverKickoff(goal);
      this.deps.toolset.discardProposal();
      return { action: "none", reason: "kickoff-delivered" };
    }

    const proposal = this.deps.toolset.consumeProposal();
    const tokensNow = this.tokenCounter?.() ?? this.deps.getTokenCount?.();

    let settled: GoalState | undefined;
    // Task gate (Maka goal-task-gate-policy): open todowrite items turn a
    // completion claim into a bounded reminder continuation, no verdict.
    let taskReminder: string | undefined;
    let taskGatePlan: ReturnType<GoalTaskGatePolicy["planAdmission"]> | undefined;
    if (proposal?.kind === "completion") {
      taskGatePlan = this.taskGate.planAdmission(goal.goalId);
      this.traceTaskGate(goal.goalId, taskGatePlan.decision, taskGatePlan.tasks);
      if (taskGatePlan.decision === "reminder_injected") taskReminder = taskGatePlan.reminder;
    }
    if (proposal?.kind === "completion" && taskReminder !== undefined) {
      // The claim is not evaluated: settle the turn like any working turn.
      settled = machine.settleTurn({
        goalId: goal.goalId,
        revision: goal.revision,
        madeProgress: activity.toolCalls > 0 ? true : undefined,
        ...(tokensNow !== undefined ? { tokensNow } : {}),
        ...(tokensNow !== undefined ? { tokensEstimated: this.tokensEstimated } : {}),
      });
      this.tokensEstimated = false;
    } else if (proposal?.kind === "completion") {
      const brief = assembleEvidenceBrief({
        objective: goal.objective,
        objectiveDigest: goal.objectiveDigest,
        ...(proposal.summary !== undefined ? { claim: proposal.summary } : {}),
        changedFiles: activity.changedFiles,
        commands: activity.commands,
        recentTail: activity.recentTail,
      });
      const verify = () =>
        verifyCompletion(
          { ...this.deps.verifier, ...(this.evaluateOverride ? { evaluate: this.evaluateOverride } : {}) },
          goal.objective,
          brief,
        );
      // One transient evaluator failure gets a retry inside the same
      // settlement; a second failure is `verifierUnavailable`, never a verdict.
      let verdict = await verify();
      if (verdict.evaluatorFailed) verdict = await verify();
      this.lastVerifierReason = verdict.evaluatorFailed
        ? undefined
        : `${verdict.reason}${verdict.missing.length > 0 ? ` (missing: ${verdict.missing.join("; ")})` : ""}`;
      settled = machine.settleTurn({
        goalId: goal.goalId,
        revision: goal.revision,
        completionClaim: { ...(proposal.summary !== undefined ? { summary: proposal.summary } : {}) },
        verifier: { verdict: verdict.verdict, ...(verdict.missing.length > 0 ? { missing: verdict.missing } : {}) },
        ...(verdict.evaluatorFailed ? { verifierUnavailable: true } : {}),
        // A rejected claim is no progress unless the turn also changed files
        // (work done, claimed early — common in batched goals); a met claim
        // completed above; an inconclusive/failed verifier is neutral.
        madeProgress: verdict.verdict === "not_met" ? activity.changedFiles.length > 0 : undefined,
        ...(tokensNow !== undefined ? { tokensNow } : {}),
        ...(tokensNow !== undefined ? { tokensEstimated: this.tokensEstimated } : {}),
      });
      this.tokensEstimated = false;
      if (settled?.status === "paused") {
        if (settled.reason === "paused(verifier_unavailable)") {
          this.inform(`Goal verifier unavailable twice (${verdict.reason}) — goal paused. /unipi:goal resume to retry.`);
        } else if (settled.reason === "paused(verifier_inconclusive)") {
          this.inform(
            `Goal verifier returned inconclusive twice — goal paused. Last evaluation: ${verdict.reason}. /unipi:goal resume.`,
          );
        } else if (settled.reason === "paused(no_progress_after_completion_claim)") {
          const missing = verdict.missing.length > 0 ? ` Missing: ${verdict.missing.join("; ")}.` : "";
          this.inform(`Completion claim rejected ${settled.notMetStreak} times — goal paused.${missing} /unipi:goal resume.`);
        }
      }
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
        ...(tokensNow !== undefined ? { tokensEstimated: this.tokensEstimated } : {}),
      });
      this.tokensEstimated = false;
    }

    if (!settled) {
      // CAS miss or race: stay quiet this turn, retry next.
      return { action: "none", reason: "no-active-goal" };
    }

    // Terminal → stop the owner; PAUSED → park it (resumable via
    // /unipi:goal resume); budget_limited adds a wrap-up turn.
    if (settled.status !== "active" && settled.status !== "waiting") {
      this.traceTaskGate(
        goal.goalId,
        settled.status === "complete" || settled.reason === "blocked(verifier_impossible)" ? "evaluator_terminal" : "goal_stopped",
        settled.status === "complete" ? [] : this.taskGate.listActionable(),
      );
      const terminal = settled.reason ?? settled.status;
      const wrapUp = settled.status === "budget_limited" && !machine.isWrapUpDelivered(settled);
      if (wrapUp) machine.markWrapUpDelivered(settled.goalId, settled.revision);
      if (settled.status === "paused") {
        // Park (resume keeps the same goal); fall back to finish if the
        // single park slot is held — the loop must still stop.
        if (!this.deps.owner.suspend(terminal)) this.deps.owner.finish(terminal);
      } else {
        this.deps.owner.finish(terminal);
      }
      if (wrapUp) this.deps.send(WRAP_UP_PROMPT);
      return { action: "stopped", terminal, wrapUp };
    }

    // Waiting: schedule the wake with exponential backoff.
    if (settled.status === "waiting") {
      // Maka records the outbox for waiting goals too: the wake timer dies
      // with the process, the durable prompt does not.
      if (!activity.aborted) {
        try {
          machine.recordPendingContinuation(settled.goalId, renderContinuationHint(settled));
        } catch {
          // best-effort
        }
      }
      this.consecutiveWaits += 1;
      const delayMs = waitBackoffMs(this.consecutiveWaits);
      this.deps.schedule?.(() => {
        const woken = this.deps.machine.wakeWaiting();
        if (woken) {
          this.consecutiveWaits = 0;
          // Timer wake while idle: an event, delivered directly — never
          // through the stash (nothing will settle to drain it).
          this.deliver(woken.goalId, renderContinuationHint(woken), { direct: true });
        }
      }, delayMs);
      return { action: "wait", delayMs };
    }

    this.consecutiveWaits = 0;
    const hintKind = selectHint(settled, activity, this.recoveryArmed);
    this.recoveryArmed = false;
    // UNI-123b: goal-mode continuations still owe the board its finish/block
    // contract — ride the reminder on every continuation message (never on
    // kickoff, wrap-up, or timer wakes).
    const boardLine = this.deps.boardLine?.() ?? null;
    const sendContinuation = (message: string): void =>
      this.deliver(settled.goalId, boardLine ? `${message}\n\n${boardLine}` : message, { persist: !activity.aborted });
    if (activity.aborted) {
      // Interrupted turn: never leave an outbox entry a restart would re-drive.
      try {
        machine.clearPendingContinuation();
      } catch {
        // best-effort
      }
    }
    if (taskReminder !== undefined && taskGatePlan) {
      const hint = hintKind === "recovery" ? `${RECOVERY_FRAGMENT}\n\n${renderContinuationHint(settled)}` : renderContinuationHint(settled);
      sendContinuation(
        `${attachTaskReminder(hint, taskReminder)}\n\n` +
          "Your completion claim was not evaluated: reconcile the task list first, then call update_goal again if the objective is met.",
      );
      this.taskGate.markStarted(settled.goalId, taskGatePlan);
      return { action: "continue", via: "task-reminder" };
    }
    switch (hintKind) {
      case "recovery":
        sendContinuation(RECOVERY_FRAGMENT);
        break;
      case "nudge-no-tool":
        sendContinuation(NO_TOOL_NUDGE);
        break;
      case "nudge-no-progress":
        sendContinuation(NO_PROGRESS_NUDGE);
        break;
      case "terminal-audit":
        sendContinuation(TERMINAL_AUDIT);
        break;
      default:
        sendContinuation(renderContinuationHint(settled, this.lastVerifierReason));
    }
    return { action: "continue", via: hintKind };
  }
}
