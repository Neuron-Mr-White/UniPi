/**
 * Goal task gate — advisory todowrite reminder before a goal may stop.
 *
 * Ported from Apache Maka `packages/runtime/src/goal-task-gate-policy.ts`
 * (GoalTaskGatePolicy): the same decision taxonomy, reminder text, and
 * per-goal reminder budget. Differences (UniPi):
 *   - the actionable list comes from the session's in-memory TodoStore
 *     (pending / in_progress items; completed and cancelled are excluded);
 *   - the gate runs when the worker proposes completion (before the
 *     independent verifier is asked), so a goal with open plan items gets a
 *     "[Task reminder]" continuation instead of a verdict;
 *   - the budget is N reminders per goal (default 2; Maka uses 1).
 * After the budget is spent the gate steps aside and completion proceeds
 * normally — a task is advisory and never overrides worktree evidence.
 */

export type GoalTaskGateDecision =
  | "evaluator_terminal"
  | "goal_stopped"
  | "no_actionable_tasks"
  | "reminder_injected"
  | "reminder_limit_reached";

export interface GoalTaskGateDeps {
  /** List only pending/in_progress tasks. Terminal tasks are excluded. */
  listActionableTasks(): readonly string[];
  /** Reminders per goal before the gate steps aside (default 2). */
  readonly maxRemindersPerGoal?: number;
}

export interface GoalTaskGateAdmissionPlan {
  readonly tasks: readonly string[];
  readonly decision: Exclude<GoalTaskGateDecision, "evaluator_terminal" | "goal_stopped">;
  readonly reminder?: string;
}

export const DEFAULT_TASK_REMINDERS_PER_GOAL = 2;
/** Bound on the rendered task list (count and per-item length). */
export const TASK_REMINDER_MAX_ITEMS = 10;
const TASK_REMINDER_ITEM_CHARS = 120;

export const TASK_GATE_REMINDER =
  "[Task reminder] Actionable session tasks remain. Reconcile them before stopping: finish them with real evidence, " +
  "or update their status truthfully. A task is advisory and never overrides files, tests, artifacts, or verifier evidence.";

/** Owns the advisory task reminder budget (per goal, in memory — Maka). */
export class GoalTaskGatePolicy {
  private readonly remindedByGoal = new Map<string, number>();

  constructor(private readonly deps: GoalTaskGateDeps | undefined) {}

  listActionable(): string[] {
    if (!this.deps) return [];
    try {
      return [...this.deps.listActionableTasks()];
    } catch {
      return [];
    }
  }

  planAdmission(goalId: string): GoalTaskGateAdmissionPlan {
    const tasks = this.listActionable();
    if (tasks.length === 0) {
      return { tasks, decision: "no_actionable_tasks" };
    }
    const limit = Math.max(0, this.deps?.maxRemindersPerGoal ?? DEFAULT_TASK_REMINDERS_PER_GOAL);
    if ((this.remindedByGoal.get(goalId) ?? 0) >= limit) {
      return { tasks, decision: "reminder_limit_reached" };
    }
    return {
      tasks,
      decision: "reminder_injected",
      reminder: renderTaskReminder(tasks),
    };
  }

  markStarted(goalId: string, plan: GoalTaskGateAdmissionPlan): void {
    if (plan.decision === "reminder_injected") {
      this.remindedByGoal.set(goalId, (this.remindedByGoal.get(goalId) ?? 0) + 1);
    }
  }

  remindersSent(goalId: string): number {
    return this.remindedByGoal.get(goalId) ?? 0;
  }
}

export function renderTaskReminder(tasks: readonly string[]): string {
  const shown = tasks.slice(0, TASK_REMINDER_MAX_ITEMS).map((task) => {
    const flat = task.replace(/\s+/g, " ").trim();
    return `- ${flat.length > TASK_REMINDER_ITEM_CHARS ? `${flat.slice(0, TASK_REMINDER_ITEM_CHARS - 1)}…` : flat}`;
  });
  const more = tasks.length > shown.length ? `\n- … and ${tasks.length - shown.length} more` : "";
  return `${TASK_GATE_REMINDER}\nActionable tasks:\n${shown.join("\n")}${more}`;
}

/**
 * Maka `attachTaskReminder`: the reminder rides between the continuation
 * preamble and the evaluation/status lines.
 */
export function attachTaskReminder(prompt: string, reminder: string | undefined): string {
  if (!reminder) return prompt;
  const markers = ["\nEvaluation:", "\nGoal:"];
  for (const marker of markers) {
    const at = prompt.indexOf(marker);
    if (at !== -1) return `${prompt.slice(0, at)}\n\n${reminder}${prompt.slice(at)}`;
  }
  return `${prompt}\n\n${reminder}`;
}
