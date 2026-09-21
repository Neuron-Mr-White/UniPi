/**
 * Ralph loop re-hosted on the long-horizon coordinator.
 *
 * Design (docs/long-horizon-design.md §4): ralph = goal mode where the
 * objective is checklist-shaped. The task-file methodology survives intact
 * (.unipi/ralph/<name>.md, iteration cadence, reflection); what changes is
 * the engine underneath — GoalMachine brings the turn cap, token budget,
 * stall semantics, verification, and durable state for free.
 *
 *   start()          write task file + state, create the goal, activate the
 *                    ralph-loop owner, deliver iteration 1
 *   onRalphDone()    lease-guarded iteration yield: settle the turn, deliver
 *                    the next iteration (or propose completion when every
 *                    item is checked → verifier judges the file)
 *
 * Task-file format is the same markdown the old package used, so existing
 * loops migrate by pointing at their files.
 */

import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDir, tryRead, writeJson } from "@pi-unipi/core";
import type { GoalMachine } from "./goal-state.js";
import type { OwnerCoordinator } from "../owner.js";

export const RALPH_DIR = ".unipi/ralph";
export const RALPH_COMPLETE_MARKER = "<promise>COMPLETE</promise>";

export interface LoopFileState {
  readonly version: number;
  readonly loopId: string;
  readonly name: string;
  readonly taskFile: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly itemsPerIteration: number;
  readonly reflectEvery: number;
  readonly status: "active" | "paused" | "complete";
  readonly goalId: string;
  readonly startedAt: string;
}

export interface RalphStartOptions {
  readonly maxIterations?: number;
  readonly itemsPerIteration?: number;
  readonly reflectEvery?: number;
  readonly tokenBudget?: number | null;
}

export interface ChecklistItem {
  readonly text: string;
  readonly checked: boolean;
  readonly line: number;
}

/** Parse markdown checkboxes; headings separate phases (kept verbatim in output). */
export function parseChecklist(markdown: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    const match = line.match(/^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/);
    if (match) {
      items.push({ checked: match[1].toLowerCase() === "x", text: match[2].trim(), line: index });
    }
  });
  return items;
}

export function nextUnchecked(items: readonly ChecklistItem[], count: number): ChecklistItem[] {
  const pending = items.filter((item) => !item.checked);
  return count > 0 ? pending.slice(0, count) : pending;
}

export const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

export interface RalphLoopDeps {
  readonly machine: GoalMachine;
  readonly owner: OwnerCoordinator;
  /** Resolve the ralph dir (usually ctx.cwd-based). */
  ralphDir(): string;
  send(message: string): void;
  now?(): number;
}

export class RalphLoop {
  private state: LoopFileState | null = null;
  private readonly deps: RalphLoopDeps;

  constructor(deps: RalphLoopDeps) {
    this.deps = deps;
  }

  private dir(): string {
    return this.deps.ralphDir();
  }

  private statePath(name: string): string {
    return `${this.dir()}/${sanitize(name)}.state.json`;
  }

  private taskPath(name: string): string {
    return `${this.dir()}/${sanitize(name)}.md`;
  }

  get(): LoopFileState | null {
    return this.state;
  }

  restore(name: string): LoopFileState | null {
    const raw = tryRead(this.statePath(name));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as LoopFileState;
      if (parsed?.version === 1) this.state = parsed;
    } catch {
      // corrupt = absent
    }
    return this.state;
  }

  /**
   * Start a loop. Rejects while another owner is active (one automation
   * owner) or while an unfinished goal exists in the machine.
   */
  start(
    name: string,
    taskContent: string,
    options: RalphStartOptions = {},
  ): { ok: true; state: LoopFileState; firstPrompt: string } | { ok: false; reason: string } {
    if (this.deps.owner.getActive()) {
      return {
        ok: false,
        reason: `session is owned by a ${this.deps.owner.getActive()?.kind} owner — finish or suspend it first`,
      };
    }
    const items = parseChecklist(taskContent);
    if (items.length === 0) {
      return { ok: false, reason: "task content has no checklist items (`- [ ]`)" };
    }

    const taskFile = `${sanitize(name)}.md`;
    const goal = this.deps.machine.create(`Complete every checklist item in ${RALPH_DIR}/${taskFile}`, {
      ...(options.maxIterations !== undefined ? { maxTurns: options.maxIterations } : {}),
      ...(options.tokenBudget !== undefined && options.tokenBudget !== null
        ? { tokenBudget: options.tokenBudget }
        : {}),
    });
    if (goal.kind === "unfinished") {
      return { ok: false, reason: `unfinished goal exists (${goal.goal.status}) — clear or complete it first` };
    }

    ensureDir(this.taskPath(name));
    writeFileSync(this.taskPath(name), taskContent, "utf-8");

    const now = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const state: LoopFileState = {
      version: 1,
      loopId: randomUUID(),
      name: sanitize(name),
      taskFile,
      iteration: 1,
      maxIterations: options.maxIterations ?? 0,
      itemsPerIteration: options.itemsPerIteration ?? 2,
      reflectEvery: options.reflectEvery ?? 5,
      status: "active",
      goalId: goal.goal.goalId,
      startedAt: now,
    };
    this.state = state;
    writeJson(this.statePath(name), state);

    this.deps.owner.activate("ralph-loop", name);
    const firstPrompt = this.buildIterationPrompt(state, false);
    this.deps.send(firstPrompt);
    return { ok: true, state, firstPrompt };
  }

  /** Lease-guarded iteration yield (the ralph_done tool's engine). */
  onRalphDone(): { ok: true; prompt?: string; completionClaim?: boolean } | { ok: false; reason: string } {
    const state = this.state;
    if (!state) return { ok: false, reason: "no active loop" };
    const owner = this.deps.owner.getActive();
    if (!owner || owner.kind !== "ralph-loop") {
      return { ok: false, reason: "ralph is not the active owner (suspended?)" };
    }

    const markdown = tryRead(this.taskPath(state.name)) ?? "";
    const items = parseChecklist(markdown);
    const remaining = items.filter((item) => !item.checked).length;

    // Settle the goal turn: iteration progress = items checked this round.
    const goal = this.deps.machine.getActive();
    if (goal) {
      this.deps.machine.settleTurn({
        goalId: goal.goalId,
        revision: goal.revision,
        madeProgress: true, // ralph_done means the iteration did its items
      });
    }

    if (remaining === 0) {
      // All items checked → completion claim; the goal verifier judges the file.
      return { ok: true, completionClaim: true };
    }

    const next = { ...state, iteration: state.iteration + 1 };
    this.state = next;
    writeJson(this.statePath(next.name), next);
    const isReflection = next.reflectEvery > 0 && next.iteration % next.reflectEvery === 0;
    const prompt = this.buildIterationPrompt(next, isReflection);
    this.deps.send(prompt);
    return { ok: true, prompt };
  }

  buildIterationPrompt(state: LoopFileState, isReflection: boolean): string {
    const markdown = tryRead(this.taskPath(state.name)) ?? "";
    const items = parseChecklist(markdown);
    const selected = nextUnchecked(items, state.itemsPerIteration);
    const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
    const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;
    const parts = [header, ""];
    if (isReflection) parts.push(DEFAULT_REFLECT_INSTRUCTIONS, "\n---\n");
    parts.push(
      `## This iteration${state.itemsPerIteration > 0 ? ` (≈${state.itemsPerIteration} items)` : ""}\n`,
    );
    if (selected.length > 0) {
      for (const item of selected) {
        parts.push(`- [ ] ${item.text}`);
      }
    } else {
      parts.push("(no unchecked items — verify the file, then claim completion)");
    }
    parts.push(`\nTask file: ${RALPH_DIR}/${state.taskFile} (${items.length - countUnchecked(items)}/${items.length} done)`);
    parts.push("\n## Instructions\n");
    parts.push("1. Work the items above; update the task file as you go (`- [x]`)");
    if (state.itemsPerIteration > 0) {
      parts.push(`2. Then call ralph_done — approximately ${state.itemsPerIteration} items per iteration`);
    } else {
      parts.push("2. Then call ralph_done to advance the iteration");
    }
    parts.push(
      `3. When EVERY item is checked and verified, call ralph_done one final time to claim completion`,
    );
    return parts.join("\n");
  }
}

function countUnchecked(items: readonly ChecklistItem[]): number {
  return items.filter((item) => !item.checked).length;
}

function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "loop";
}
