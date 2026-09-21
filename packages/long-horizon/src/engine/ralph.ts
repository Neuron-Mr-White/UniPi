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
import {
  assembleEvidenceBrief,
  verifyCompletion,
  type VerificationVerdict,
  type VerifierDeps,
} from "./verifier.js";

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
  /** Footer/info-screen events (loop_start / iteration_done / loop_end). */
  onEvent?(event: RalphEvent): void;
}

export type RalphEvent =
  | { type: "loop_start"; name: string; iteration: number; total: number }
  | { type: "iteration_done"; name: string; iteration: number; remaining: number }
  | { type: "loop_end"; name: string; reason: string; iterations: number };

export class RalphLoop {
  private state: LoopFileState | null = null;
  private evaluateOverride?: VerifierDeps["evaluate"];
  private readonly deps: RalphLoopDeps;

  constructor(deps: RalphLoopDeps) {
    this.deps = deps;
  }

  /** Late-bound verifier (runtime wiring resolves the model per session). */
  setEvaluate(evaluate: VerifierDeps["evaluate"]): void {
    this.evaluateOverride = evaluate;
  }

  /** Checked/total/next summary for the loop_status tool and footer. */
  progressSummary(): { checked: number; total: number; next: string[] } {
    const state = this.state;
    if (!state) return { checked: 0, total: 0, next: [] };
    const items = parseChecklist(tryRead(this.taskPath(state.name)) ?? "");
    const checked = items.filter((item) => item.checked).length;
    return {
      checked,
      total: items.length,
      next: nextUnchecked(items, state.itemsPerIteration).map((item) => item.text),
    };
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
    const itemsTotal = parseChecklist(taskContent).length;
    this.deps.onEvent?.({ type: "loop_start", name: state.name, iteration: 1, total: itemsTotal });
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
      // All items checked → completion claim; the verifier judges the file.
      this.deps.onEvent?.({ type: "iteration_done", name: state.name, iteration: state.iteration, remaining: 0 });
      return { ok: true, completionClaim: true };
    }

    const next = { ...state, iteration: state.iteration + 1 };
    this.state = next;
    writeJson(this.statePath(next.name), next);
    this.deps.onEvent?.({ type: "iteration_done", name: state.name, iteration: next.iteration, remaining });
    const isReflection = next.reflectEvery > 0 && next.iteration % next.reflectEvery === 0;
    const prompt = this.buildIterationPrompt(next, isReflection);
    this.deps.send(prompt);
    return { ok: true, prompt };
  }

  /**
   * Verify an all-checked claim against the task file and settle the goal.
   * met completes the loop; anything else keeps it running with feedback.
   */
  async verifyCompletion(): Promise<
    | { kind: "met"; reason: string }
    | { kind: "not_met"; reason: string; missing: string[] }
    | { kind: "inconclusive"; reason: string }
  > {
    const state = this.state;
    const goal = state ? this.deps.machine.getActive() : undefined;
    if (!state || !goal) return { kind: "inconclusive", reason: "no active loop goal" };

    const brief = assembleEvidenceBrief({
      objective: goal.objective,
      objectiveDigest: goal.objectiveDigest,
      claim: "Every checklist item in the task file is checked.",
      changedFiles: [`.unipi/ralph/${state.taskFile}`],
      commands: [],
      recentTail: [],
    });
    const verdict: VerificationVerdict = await verifyCompletion(
      {
        evaluate: this.evaluateOverride ?? (async () => { throw new Error("verifier unbound"); }),
      },
      goal.objective,
      brief,
    );

    const settled = this.deps.machine.settleTurn({
      goalId: goal.goalId,
      revision: goal.revision,
      completionClaim: { summary: "all items checked" },
      verifier: {
        verdict: verdict.verdict,
        ...(verdict.missing.length > 0 ? { missing: verdict.missing } : {}),
      },
    });

    if (verdict.verdict === "met" || settled?.status === "complete") {
      this.state = state.status === "complete" ? state : { ...state, status: "complete" };
      writeJson(this.statePath(state.name), this.state);
      this.deps.owner.finish("complete(verifier_met)");
      this.deps.onEvent?.({
        type: "loop_end",
        name: state.name,
        reason: "complete(verifier_met)",
        iterations: state.iteration,
      });
      return { kind: "met", reason: verdict.reason };
    }
    if (verdict.verdict === "not_met") {
      return { kind: "not_met", reason: verdict.reason, missing: [...verdict.missing] };
    }
    return { kind: "inconclusive", reason: verdict.reason };
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
