/**
 * Goal state machine — the mcode spine with Maka's settlement arithmetic.
 *
 * Statuses: active | waiting | paused | complete | blocked | budget_limited |
 * usage_limited. Waiting is non-terminal (external event); everything after
 * paused-in-the-taxonomy below that is not listed as terminal is recoverable
 * via resume (lease renewed) except complete.
 *
 * Settlement rules per turn (design §3, study §3/§6):
 *   - token budget is BASELINE-PENDING: the first settlement that observes
 *     tokensNow writes the baseline — "the budget bounds what the goal
 *     drives, not the turn it was born beside" (Maka)
 *   - turn cap: turn + 1 >= maxTurns → budget_limited(max_turns)
 *   - stall: madeProgress=true resets the streak; false increments toward
 *     stallCap → paused(no_progress); undefined is NEUTRAL (verifier failure
 *     can neither fake progress nor trip the stall detector)
 *   - worker completion proposals never complete directly: only verifier met
 *     or user request does (propose + verify). A rejected claim counts as
 *     no-progress for that turn and feeds notMetStreak.
 *   - blocked requires 3 consecutive blocked proposals (mcode threshold);
 *     safety/policy refusals are immediate
 *   - every settlement carries {goalId, revision} — CAS; stale settlements
 *     are silently ignored
 */

import { createHash, randomUUID } from "node:crypto";
import { tryRead, writeJson, ensureDir } from "@pi-unipi/core";

export const GOAL_STATUSES = [
  "active",
  "waiting",
  "paused",
  "complete",
  "blocked",
  "budget_limited",
  "usage_limited",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "complete",
  "blocked",
  "budget_limited",
  "usage_limited",
]);

/**
 * Reason taxonomy (mcode's 25 collapsed to v1 scope: no main_turn/active_time
 * budgets, verifier failure variants collapsed to verifier_unavailable).
 */
export const GOAL_STATUS_REASONS = [
  "complete(verifier_met)",
  "complete(user_requested)",
  "paused(user_requested)",
  "paused(superseded)",
  "paused(verifier_unavailable)",
  "paused(no_progress)",
  "paused(no_progress_after_completion_claim)",
  "blocked(threshold_3turns)",
  "blocked(safety_policy)",
  "blocked(verifier_impossible)",
  "waiting(external_event)",
  "budget_limited(token)",
  "budget_limited(max_turns)",
  "usage_limited(provider_quota)",
  "usage_limited(rate_limit)",
] as const;

export type GoalStatusReason = (typeof GOAL_STATUS_REASONS)[number];

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_STALL_CAP = 8;
export const MAX_TURNS_CEILING = 200;
export const STALL_CAP_CEILING = 50;
export const TOKEN_BUDGET_MINIMUM = 1_000;
export const BLOCKED_PROPOSAL_THRESHOLD = 3;
/** mcode: a verifier that keeps saying not_met this many times after claims parks the goal. */
export const NOT_MET_STREAK_CAP = 3;

export const GOAL_CONDITION_LIMIT = { codeUnits: 500, utf8Bytes: 1_500 } as const;

export interface GoalLease {
  readonly goalId: string;
  readonly generation: number;
}

export type VerifierVerdict = "met" | "not_met" | "impossible" | "inconclusive";

export interface GoalState {
  readonly goalId: string;
  readonly objective: string;
  readonly objectiveDigest: string;
  readonly status: GoalStatus;
  readonly reason?: GoalStatusReason;
  readonly tokenBudget: number | null;
  /** Written at the first settlement that observes tokensNow. */
  readonly tokensBaselinePending: boolean;
  readonly tokensAtStart: number;
  readonly tokensNow: number;
  readonly turn: number;
  readonly maxTurns: number;
  readonly noProgressStreak: number;
  readonly stallCap: number;
  /** Consecutive verifier not_met verdicts on completion claims. */
  readonly notMetStreak: number;
  /** Consecutive blocked proposals (blocked needs 3 in a row). */
  readonly blockedProposalStreak: number;
  readonly lease: GoalLease;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface GoalSettlement {
  readonly goalId: string;
  readonly revision: number;
  /** Worker proposed completion this turn (verify before settling met). */
  readonly completionClaim?: { readonly summary?: string };
  /** Verifier outcome for this turn's claim, when verification ran. */
  readonly verifier?: {
    readonly verdict: VerifierVerdict;
    readonly missing?: readonly string[];
  };
  /** Host-side judge of progress; undefined = neutral (evaluator failure). */
  readonly madeProgress?: boolean;
  readonly waiting?: boolean;
  readonly tokensNow?: number;
  /** Worker proposed blocked this turn (non-safety). */
  readonly blockedProposal?: boolean;
  /** Safety/policy refusal — immediately terminal. */
  readonly safetyRefusal?: boolean;
}

export interface GoalCreateOptions {
  readonly tokenBudget?: number | null;
  readonly maxTurns?: number;
  readonly stallCap?: number;
}

export interface GoalMachineDeps {
  statePath(): string;
  now?(): number;
  onChange?(state: GoalState, previous: GoalStatus | undefined): void;
}

export function digestObjective(objective: string): string {
  return createHash("sha256").update(objective).digest("hex");
}

export function isConditionWithinLimit(value: string): boolean {
  return (
    value.length <= GOAL_CONDITION_LIMIT.codeUnits &&
    Buffer.byteLength(value, "utf8") <= GOAL_CONDITION_LIMIT.utf8Bytes
  );
}

interface StoredState {
  version: number;
  goal: GoalState | null;
}

export class GoalMachine {
  private goal: GoalState | null = null;
  private readonly deps: GoalMachineDeps;

  constructor(deps: GoalMachineDeps) {
    this.deps = deps;
  }

  // ── reads ────────────────────────────────────────────────────────────

  get(): GoalState | null {
    return this.goal;
  }

  getActive(): GoalState | null {
    const goal = this.goal;
    return goal && !TERMINAL_GOAL_STATUSES.has(goal.status) ? goal : null;
  }

  restore(): GoalState | null {
    const raw = tryRead(this.deps.statePath());
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredState;
      if (parsed?.version === 1 && parsed.goal) {
        this.goal = parsed.goal;
      }
    } catch {
      // Corrupt state = absent (repair, don't resurrect).
    }
    return this.goal;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  create(objective: string, options: GoalCreateOptions = {}):
    | { kind: "created"; goal: GoalState }
    | { kind: "unfinished"; goal: GoalState } {
    const trimmed = objective.trim();
    if (!trimmed || !isConditionWithinLimit(trimmed)) {
      throw new RangeError("Goal objective exceeds its shared text limit");
    }
    const existing = this.goal;
    if (existing && !TERMINAL_GOAL_STATUSES.has(existing.status)) {
      return { kind: "unfinished", goal: existing };
    }
    const now = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const goalId = randomUUID();
    const goal: GoalState = Object.freeze({
      goalId,
      objective: trimmed,
      objectiveDigest: digestObjective(trimmed),
      status: "active",
      tokenBudget: options.tokenBudget ?? null,
      tokensBaselinePending: true,
      tokensAtStart: 0,
      tokensNow: 0,
      turn: 0,
      maxTurns: Math.min(options.maxTurns ?? DEFAULT_MAX_TURNS, MAX_TURNS_CEILING),
      noProgressStreak: 0,
      stallCap: Math.min(options.stallCap ?? DEFAULT_STALL_CAP, STALL_CAP_CEILING),
      notMetStreak: 0,
      blockedProposalStreak: 0,
      lease: Object.freeze({ goalId, generation: 0 }),
      revision: 0,
      updatedAt: now,
    });
    this.goal = goal;
    this.commit(goal, undefined);
    return { kind: "created", goal };
  }

  pause(reason: Extract<GoalStatusReason, `paused${string}`>): GoalState | undefined {
    const goal = this.goal;
    if (!goal || goal.status !== "active") return undefined;
    const next = this.withGoal(goal, { status: "paused", reason, lease: renew(goal.lease) });
    this.goal = next;
    this.commit(next, goal.status);
    return next;
  }

  resume(): GoalState | undefined {
    const goal = this.goal;
    if (!goal || goal.status !== "paused") return undefined;
    const next = this.withGoal(goal, {
      status: "active",
      lease: renew(goal.lease),
      // mcode: a resumed run gets a fresh blocked audit.
      blockedProposalStreak: 0,
    });
    this.goal = next;
    this.commit(next, goal.status);
    return next;
  }

  wakeWaiting(): GoalState | undefined {
    const goal = this.goal;
    if (!goal || goal.status !== "waiting") return undefined;
    const next = this.withGoal(goal, { status: "active" });
    this.goal = next;
    this.commit(next, goal.status);
    return next;
  }

  clear(): GoalState | undefined {
    const goal = this.goal;
    if (!goal || TERMINAL_GOAL_STATUSES.has(goal.status)) return undefined;
    const next = this.withGoal(goal, { status: "complete", reason: "complete(user_requested)", lease: renew(goal.lease) });
    this.goal = next;
    this.commit(next, goal.status);
    return next;
  }

  /** Budget mutation after the tool layer CAS-checked get_goal freshness. */
  setTokenBudget(budget: number | null): GoalState | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    const next = this.withGoal(goal, { tokenBudget: budget });
    this.goal = next;
    this.commit(next, goal.status);
    return next;
  }

  // ── settlement ───────────────────────────────────────────────────────

  settleTurn(input: GoalSettlement): GoalState | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    // CAS: stale settlements are silently ignored.
    if (goal.goalId !== input.goalId || goal.revision !== input.revision) return undefined;
    if (goal.status !== "active" && goal.status !== "waiting") return undefined;

    let status: GoalStatus = goal.status;
    let reason: GoalStatusReason | undefined = goal.reason;
    let tokensAtStart = goal.tokensAtStart;
    let tokensNow = goal.tokensNow;
    let tokensBaselinePending = goal.tokensBaselinePending;
    let turn = goal.turn;
    let noProgressStreak = goal.noProgressStreak;
    let notMetStreak = goal.notMetStreak;
    let blockedProposalStreak = goal.blockedProposalStreak;

    // 1. Verification of a completion claim decides completion.
    if (input.completionClaim && input.verifier) {
      if (input.verifier.verdict === "met") {
        const next = this.withGoal(goal, { status: "complete", reason: "complete(verifier_met)" });
        this.goal = next;
        this.commit(next, goal.status);
        return next;
      }
      if (input.verifier.verdict === "impossible") {
        const next = this.withGoal(goal, { status: "blocked", reason: "blocked(verifier_impossible)" });
        this.goal = next;
        this.commit(next, goal.status);
        return next;
      }
      // not_met / inconclusive: the claim failed. Count it.
      notMetStreak = input.verifier.verdict === "not_met" ? notMetStreak + 1 : notMetStreak;
      if (notMetStreak >= NOT_MET_STREAK_CAP && noProgressStreak + 1 >= goal.stallCap) {
        const next = this.withGoal(goal, {
          status: "paused",
          reason: "paused(no_progress_after_completion_claim)",
        });
        this.goal = next;
        this.commit(next, goal.status);
        return next;
      }
    }

    // 2. Safety refusal is immediately terminal.
    if (input.safetyRefusal) {
      const next = this.withGoal(goal, { status: "blocked", reason: "blocked(safety_policy)" });
      this.goal = next;
      this.commit(next, goal.status);
      return next;
    }

    // 3. Blocked audit: 3 consecutive non-safety proposals.
    if (input.blockedProposal) {
      blockedProposalStreak += 1;
      if (blockedProposalStreak >= BLOCKED_PROPOSAL_THRESHOLD) {
        const next = this.withGoal(goal, { status: "blocked", reason: "blocked(threshold_3turns)", blockedProposalStreak });
        this.goal = next;
        this.commit(next, goal.status);
        return next;
      }
    } else {
      blockedProposalStreak = 0;
    }

    // 4. Token accounting (baseline-pending) and budget.
    if (input.tokensNow !== undefined) {
      if (tokensBaselinePending) {
        tokensAtStart = input.tokensNow;
        tokensNow = input.tokensNow;
        tokensBaselinePending = false;
      } else {
        tokensNow = Math.max(tokensNow, input.tokensNow);
      }
      if (goal.tokenBudget !== null && tokensNow - tokensAtStart >= goal.tokenBudget) {
        const next = this.withGoal(goal, {
          status: "budget_limited",
          reason: "budget_limited(token)",
          tokensAtStart,
          tokensNow,
          tokensBaselinePending,
        });
        this.goal = next;
        this.commit(next, goal.status);
        return next;
      }
    }

    // 5. Turn cap.
    turn += 1;
    if (turn >= goal.maxTurns) {
      const next = this.withGoal(goal, { status: "budget_limited", reason: "budget_limited(max_turns)", turn });
      this.goal = next;
      this.commit(next, goal.status);
      return next;
    }

    // 6. Stall accounting (undefined = neutral).
    if (input.madeProgress !== undefined) {
      if (input.madeProgress) {
        noProgressStreak = 0;
      } else {
        noProgressStreak += 1;
        if (noProgressStreak >= goal.stallCap) {
          const next = this.withGoal(goal, {
            status: "paused",
            reason: "paused(no_progress)",
            turn,
            noProgressStreak,
            notMetStreak,
            blockedProposalStreak,
          });
          this.goal = next;
          this.commit(next, goal.status);
          return next;
        }
      }
    }

    // 7. Waiting.
    if (input.waiting) {
      status = "waiting";
      reason = "waiting(external_event)";
    } else if (status === "waiting") {
      status = "active";
      reason = undefined;
    }

    const next = this.withGoal(goal, {
      status,
      ...(reason !== undefined ? { reason } : { reason: undefined }),
      tokensAtStart,
      tokensNow,
      tokensBaselinePending,
      turn,
      noProgressStreak,
      notMetStreak,
      blockedProposalStreak,
    });
    this.goal = next;
    this.commit(next, goal.status);
    return next;
  }

  // ── internals ────────────────────────────────────────────────────────

  private withGoal(goal: GoalState, patch: Partial<GoalState>): GoalState {
    return Object.freeze({
      ...goal,
      ...patch,
      revision: goal.revision + 1,
      updatedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
    });
  }

  private commit(goal: GoalState, previous: GoalStatus | undefined): void {
    const path = this.deps.statePath();
    ensureDir(path);
    writeJson(path, { version: 1, goal } satisfies StoredState);
    this.deps.onChange?.(goal, previous);
  }
}

function renew(lease: GoalLease): GoalLease {
  return Object.freeze({ goalId: lease.goalId, generation: lease.generation + 1 });
}
