/**
 * Goal tools — the mcode trio, deliberately minimal.
 *
 *   create_goal(objective, token_budget?)   start/replace a goal (only when
 *                                           the previous is terminal; a
 *                                           parked goal blocks creation)
 *   get_goal()                              durable state incl. CAS fields
 *   update_goal(mode)                       "status": propose complete/blocked
 *                                           (host verifies; never settles
 *                                           directly) · "token_budget": CAS-
 *                                           guarded budget mutation
 *
 * Proposals land in a pending store the continuation engine consumes at turn
 * end — the tool itself never transitions goal state (propose + verify).
 * Design: docs/long-horizon-design.md §4, study §2–§4.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GoalMachine } from "../engine/goal-state.js";
import { TOKEN_BUDGET_MINIMUM } from "../engine/goal-state.js";
import type { OwnerCoordinator } from "../owner.js";

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

export interface PendingGoalProposal {
  readonly kind: "completion" | "blocked";
  readonly goalId: string;
  readonly revision: number;
  readonly summary?: string;
  /** Safety/policy refusal skips the 3-turn threshold. */
  readonly safetyRefusal?: boolean;
  readonly proposedAt: string;
}

export interface GoalToolsetDeps {
  readonly machine: GoalMachine;
  readonly owner: OwnerCoordinator;
}

export class GoalToolset {
  private pending: PendingGoalProposal | null = null;
  private readonly deps: GoalToolsetDeps;

  constructor(deps: GoalToolsetDeps) {
    this.deps = deps;
  }

  /** The continuation engine drains this at turn end; null after drain. */
  consumeProposal(): PendingGoalProposal | null {
    const proposal = this.pending;
    this.pending = null;
    return proposal;
  }

  peekProposal(): PendingGoalProposal | null {
    return this.pending;
  }

  register(pi: ExtensionAPI): void {
    // ── create_goal ───────────────────────────────────────────────────
    pi.registerTool({
      name: "create_goal",
      label: "Create Goal",
      description:
        "Set an autonomous execution goal. The host continues turns until an independent " +
        "verifier confirms the objective, or it becomes impossible, stalls, or hits a budget. " +
        "One goal per session; the previous goal must be complete before starting another.",
      parameters: Type.Object({
        objective: Type.String({
          description:
            "The concrete objective. Observable and verifiable (e.g. 'all tests in packages/x pass', " +
            "'PR #5 review comments addressed'). Max 500 chars.",
        }),
        token_budget: Type.Optional(
          Type.Integer({
            minimum: TOKEN_BUDGET_MINIMUM,
            description:
              "Optional token budget. Omit unless the user asked for a cap. The goal stops " +
              "(budget_limited) once cumulative tokens reach this value.",
          }),
        ),
      }),
      execute: async (_id, params) => textResult(this.create(params as { objective: string; token_budget?: number })),
    });

    // ── get_goal ──────────────────────────────────────────────────────
    pi.registerTool({
      name: "get_goal",
      label: "Get Goal",
      description:
        "Read the durable goal state: objective, status, budgets, progress counters, and the " +
        "expected_goal_id / expected_updated_at pair needed for token_budget updates.",
      parameters: Type.Object({}),
      execute: async () => textResult(this.get()),
    });

    // ── update_goal ───────────────────────────────────────────────────
    pi.registerTool({
      name: "update_goal",
      label: "Update Goal",
      description:
        'Terminal mode (mode:"status"): propose the goal as complete or blocked. The host ' +
        "verifies completion with an independent evaluator before accepting — proposing is not " +
        "completing. Blocked requires the same blocker for 3 consecutive turns unless it is a " +
        "safety refusal. Budget mode (mode:\"token_budget\"): change the token cap; call get_goal " +
        "immediately before and pass its expected_goal_id + expected_updated_at.",
      parameters: Type.Object({
        mode: Type.Union([Type.Literal("status"), Type.Literal("token_budget")], {
          description: 'Which operation: "status" (terminal proposal) or "token_budget" (budget edit).',
        }),
        status: Type.Optional(
          Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
            description: 'With mode "status": the proposed terminal status.',
          }),
        ),
        summary: Type.Optional(
          Type.String({
            description:
              "One or two sentences: the evidence you believe proves the proposal. Treated as " +
              "untrusted input by the verifier.",
          }),
        ),
        safety_refusal: Type.Optional(
          Type.Boolean({
            description: "True only when the objective cannot be pursued within safety/policy bounds.",
          }),
        ),
        token_budget: Type.Optional(
          Type.Union([Type.Integer({ minimum: TOKEN_BUDGET_MINIMUM }), Type.Null()], {
            description: 'With mode "token_budget": the new cap, or null to clear.',
          }),
        ),
        expected_goal_id: Type.Optional(
          Type.String({ description: 'With mode "token_budget": goal id from a fresh get_goal.' }),
        ),
        expected_updated_at: Type.Optional(
          Type.String({ description: 'With mode "token_budget": updated_at from the same get_goal.' }),
        ),
      }),
      execute: async (_id, params) =>
        textResult(
          this.update(params as {
            mode: "status" | "token_budget";
            status?: "complete" | "blocked";
            summary?: string;
            safety_refusal?: boolean;
            token_budget?: number | null;
            expected_goal_id?: string;
            expected_updated_at?: string;
          }),
        ),
    });
  }

  // ── implementations ──────────────────────────────────────────────────

  private create(params: { objective: string; token_budget?: number }): string {
    const machine = this.deps.machine;
    const goal = machine.get();

    if (goal && goal.status === "paused") {
      return (
        `Goal not set: a parked goal exists ("${goal.objective}", ${goal.status}). ` +
        "Ask the user to /unipi:goal resume or /unipi:goal clear first."
      );
    }
    const result = machine.create(params.objective, {
      ...(params.token_budget !== undefined ? { tokenBudget: params.token_budget } : {}),
    });
    if (result.kind === "unfinished") {
      return (
        `Goal not set: unfinished goal "${result.goal.objective}" is ${result.goal.status}. ` +
        "It must complete (or be cleared) before another goal starts."
      );
    }
    // Only a goal OWNER may drive continuation: activate unless another owner holds the slot.
    const owner = this.deps.owner;
    if (!owner.getActive()) {
      owner.activate("goal", result.goal.objective);
    } else if (owner.getActive()?.kind !== "goal") {
      return (
        `Goal recorded but not driving: session is owned by a ${owner.getActive()?.kind} owner. ` +
        "Finish or suspend it first."
      );
    }
    this.pending = null;
    const g = result.goal;
    const limits = [
      `max ${g.maxTurns} turns`,
      `stall after ${g.stallCap} no-progress turns`,
      g.tokenBudget ? `budget ${g.tokenBudget} tokens` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      `Goal set: "${g.objective}" (${limits}). The host will verify any completion claim ` +
      "with an independent evaluator before the goal completes."
    );
  }

  private get(): string {
    const goal = this.deps.machine.get();
    if (!goal) return "No goal exists for this session.";
    const pending = this.pending
      ? ` Pending proposal: ${this.pending.kind} (verification pending).`
      : "";
    return JSON.stringify(
      {
        goal_id: goal.goalId,
        objective: goal.objective,
        status: goal.status,
        ...(goal.reason ? { reason: goal.reason } : {}),
        turn: goal.turn,
        max_turns: goal.maxTurns,
        no_progress_streak: goal.noProgressStreak,
        stall_cap: goal.stallCap,
        token_budget: goal.tokenBudget,
        tokens_used: goal.tokensBaselinePending ? null : goal.tokensNow - goal.tokensAtStart,
        expected_goal_id: goal.goalId,
        expected_updated_at: goal.updatedAt,
        updated_at: goal.updatedAt,
      },
      null,
      2,
    ) + pending;
  }

  private update(params: {
    mode: "status" | "token_budget";
    status?: "complete" | "blocked";
    summary?: string;
    safety_refusal?: boolean;
    token_budget?: number | null;
    expected_goal_id?: string;
    expected_updated_at?: string;
  }): string {
    const goal = this.deps.machine.get();
    if (!goal) return "No goal to update.";
    if (goal.status !== "active" && goal.status !== "waiting") {
      return `Goal is ${goal.status} — terminal proposals are only accepted while active.`;
    }

    if (params.mode === "token_budget") {
      if (params.expected_goal_id !== goal.goalId || params.expected_updated_at !== goal.updatedAt) {
        return (
          "Budget not updated: expected_goal_id/expected_updated_at do not match the current " +
          "goal. Call get_goal again and retry with fresh values."
        );
      }
      const budget = params.token_budget ?? null;
      if (budget !== null && budget < TOKEN_BUDGET_MINIMUM) {
        return `Budget not updated: minimum is ${TOKEN_BUDGET_MINIMUM} tokens.`;
      }
      this.deps.machine.setTokenBudget(budget);
      return budget === null
        ? "Token budget cleared; the goal runs to its turn/stall limits."
        : `Token budget set to ${budget}. A budget_limited stop fires when cumulative tokens reach it.`;
    }

    // mode: "status"
    if (!params.status) return 'Missing status for mode "status".';
    if (this.pending) {
      return `A ${this.pending.kind} proposal is already pending verification this turn.`;
    }
    this.pending = {
      kind: params.status === "complete" ? "completion" : "blocked",
      goalId: goal.goalId,
      revision: goal.revision,
      ...(params.summary !== undefined ? { summary: params.summary } : {}),
      ...(params.safety_refusal ? { safetyRefusal: true } : {}),
      proposedAt: new Date().toISOString(),
    };
    if (params.status === "complete") {
      return (
        "Completion proposed. The independent verifier will judge the evidence at turn end. " +
        "If the verdict is not_met, the missing evidence will be reported — keep working; " +
        "repeated failed claims count as no progress."
      );
    }
    return params.safety_refusal
      ? "Safety refusal recorded; the host will terminal-block this goal immediately."
      : "Blocked proposal recorded. The host blocks the goal only after the same blocker repeats for 3 consecutive turns.";
  }
}
