/**
 * todowrite — the visible session plan (mcode pattern).
 *
 * Snapshot-replace: the model submits the COMPLETE list, not deltas. At most
 * one item may be in_progress. Updating the list is not completing the work
 * — the description says so, and the goal gate ignores todo state for
 * settlement (evidence comes from the worktree, not the plan).
 *
 * State is session-local and in-memory; consumers (footer/info-screen)
 * render from the emitted event, per the design §8 classification.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export const TODO_PRIORITIES = ["high", "medium", "low"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

export const MAX_TODO_ITEMS = 50;
export const MAX_TODO_CONTENT_CHARS = 200;

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
}

export type TodoList = readonly TodoItem[];

export type TodoWriteResult =
  | { kind: "ok"; list: TodoList }
  | { kind: "rejected"; reason: string };

export function normalizeTodoItem(raw: {
  content?: unknown;
  status?: unknown;
  priority?: unknown;
}): TodoItem | { error: string } {
  if (typeof raw.content !== "string" || raw.content.trim().length === 0) {
    return { error: "every todo needs non-empty content" };
  }
  if (typeof raw.status !== "string" || !(TODO_STATUSES as readonly string[]).includes(raw.status)) {
    return { error: `status must be one of ${TODO_STATUSES.join(", ")}` };
  }
  const priority =
    typeof raw.priority === "string" && (TODO_PRIORITIES as readonly string[]).includes(raw.priority)
      ? (raw.priority as TodoPriority)
      : "medium";
  return {
    content: raw.content.trim().slice(0, MAX_TODO_CONTENT_CHARS),
    status: raw.status as TodoStatus,
    priority,
  };
}

export function validateTodoList(items: readonly TodoItem[]): TodoWriteResult {
  if (items.length > MAX_TODO_ITEMS) {
    return { kind: "rejected", reason: `too many items (${items.length} > ${MAX_TODO_ITEMS})` };
  }
  const inProgress = items.filter((item) => item.status === "in_progress");
  if (inProgress.length > 1) {
    return {
      kind: "rejected",
      reason: `at most one item may be in_progress (got ${inProgress.length})`,
    };
  }
  return { kind: "ok", list: items };
}

/** Compact deterministic rendering (footer/glance friendly). */
export function renderTodoLine(list: TodoList): string {
  const counts = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
  for (const item of list) counts[item.status] += 1;
  const total = list.length - counts.cancelled;
  if (total === 0) return "no plan";
  const current = list.find((item) => item.status === "in_progress");
  const progress = `${counts.completed}/${total}`;
  return current ? `${progress} · ▶ ${current.content.slice(0, 60)}` : `${progress}`;
}

export class TodoStore {
  private list: TodoList = [];

  get(): TodoList {
    return this.list;
  }

  write(rawItems: readonly unknown[]): TodoWriteResult {
    const items: TodoItem[] = [];
    for (const raw of rawItems) {
      if (typeof raw !== "object" || raw === null) {
        return { kind: "rejected", reason: "every todo must be an object" };
      }
      const normalized = normalizeTodoItem(raw as Record<string, unknown>);
      if ("error" in normalized) return { kind: "rejected", reason: normalized.error };
      items.push(normalized);
    }
    const validated = validateTodoList(items);
    if (validated.kind === "rejected") return validated;
    this.list = validated.list;
    return validated;
  }
}

export function registerTodoTool(pi: ExtensionAPI, store: TodoStore): void {
  pi.registerTool({
    name: "todowrite",
    label: "Todo Write",
    description:
      "Replace the visible session task list with a complete snapshot.\n\n" +
      "- Use for multiple meaningful steps; skip single-step, trivial, or conversational work.\n" +
      "- Mark an item in_progress before starting it; at most one may be in_progress.\n" +
      "- Mark finished work completed and obsolete work cancelled promptly.\n" +
      "- Before final delivery, reconcile statuses with the actual work. Updating the list does not complete the work.",
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "Brief description of the task" }),
          status: Type.String({ description: `Current status: ${TODO_STATUSES.join(", ")}` }),
          priority: Type.String({ description: `Priority: ${TODO_PRIORITIES.join(", ")}` }),
        }),
        { description: "The complete task list snapshot (replaces the previous list)." },
      ),
    }),
    execute: async (
      _id,
      params,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: { rejected?: boolean; count?: number };
    }> => {
      const { todos } = params as { todos: unknown[] };
      const result = store.write(todos);
      if (result.kind === "rejected") {
        return {
          content: [{ type: "text", text: `Todo list rejected: ${result.reason}` }],
          details: { rejected: true },
        };
      }
      emitEvent(pi, UNIPI_EVENTS.LONG_HORIZON_TODO_UPDATED, {
        list: result.list,
        line: renderTodoLine(result.list),
      });
      return {
        content: [{ type: "text", text: `Plan updated: ${renderTodoLine(result.list)}` }],
        details: { count: result.list.length },
      };
    },
  });
}
