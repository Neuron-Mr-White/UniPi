/**
 * Long-horizon progress snapshot (UNI-222) — the ONE truth behind
 * `/unipi:visualize-progress` (TUI) and the app's Progress sheet.
 *
 * `lhProgressSnapshot()` is pure: it folds the owner coordinator, the graph /
 * swarm ledgers, the ralph checklist and the goal machine (+ its last
 * estimate) into one UI-shaped `LhProgressEvent`. `nextProgressLog()` derives
 * the log by DIFFING two snapshots — the log never carries text of its own,
 * so a log line and a box state can never disagree (live-panel "one truth").
 * index.ts publishes the result as the sticky `LH_PROGRESS` bus event on
 * every change.
 */

import type { LhProgressEvent, LhProgressItem, LhProgressLogLine, LhProgressRun } from "@pi-unipi/core";
import type { ChecklistItem, LoopFileState } from "./engine/ralph.js";
import type { GoalState } from "./engine/goal-state.js";
import type { OwnerKind } from "./modes.js";
import type { GraphItemStatus } from "./tools/graph.js";
import type { SwarmItemStatus } from "./tools/swarm.js";

type RunMode = LhProgressRun["mode"];

export interface ProgressOwner {
  readonly kind: OwnerKind;
  readonly label: string;
  readonly status: "active" | "parked";
  readonly reason?: string;
}

export interface ProgressFinished {
  readonly kind: OwnerKind;
  readonly label: string;
  readonly terminalReason: string;
  readonly endedAt: string;
}

export interface ProgressGraphInput {
  readonly task: string;
  readonly items: ReadonlyArray<{
    readonly itemId: string;
    readonly instruction: string;
    readonly dependsOn: readonly string[];
    readonly wave: number;
    readonly status: GraphItemStatus;
    readonly attempts: number;
    readonly summary?: string;
  }>;
}

export interface ProgressSwarmInput {
  readonly task: string;
  readonly items: ReadonlyArray<{
    readonly itemId: string;
    readonly instruction: string;
    readonly status: SwarmItemStatus;
    readonly attempts: number;
    readonly summary?: string;
  }>;
}

export interface ProgressRalphInput {
  readonly state: Pick<LoopFileState, "name" | "iteration" | "maxIterations" | "itemsPerIteration" | "status">;
  readonly checklist: readonly Pick<ChecklistItem, "text" | "checked">[];
}

export interface ProgressGoalEstimate {
  readonly goalId: string;
  readonly percent: number;
  readonly summary: string;
  readonly at: number;
}

export interface LhProgressInput {
  /** The active owner, else the parked one. */
  readonly owner?: ProgressOwner;
  /** Newest finished owner (owner history[0]). */
  readonly finished?: ProgressFinished;
  readonly graph?: ProgressGraphInput | null;
  readonly swarm?: ProgressSwarmInput | null;
  readonly ralph?: ProgressRalphInput | null;
  readonly goal?: Pick<GoalState, "goalId" | "objective" | "status" | "turn" | "maxTurns"> | null;
  readonly goalEstimate?: ProgressGoalEstimate;
  readonly now: number;
}

export const LABEL_MAX = 160;
export const SUMMARY_MAX = 300;
export const ITEMS_MAX = 200;
export const LOG_MAX = 40;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function modeOfKind(kind: OwnerKind): RunMode {
  return kind === "ralph-loop" ? "ralph" : kind;
}

const GRAPH_STATUS: Record<GraphItemStatus, LhProgressItem["status"]> = {
  queued: "queued",
  ready: "ready",
  dispatched: "running",
  completed: "done",
  failed: "failed",
  aborted: "aborted",
};

const SWARM_STATUS: Record<SwarmItemStatus, LhProgressItem["status"]> = {
  queued: "queued",
  dispatched: "running",
  completed: "done",
  failed: "failed",
  aborted: "aborted",
};

/** Run status of a finished owner from its terminal reason. */
export function finishedStatus(reason: string): LhProgressRun["status"] {
  if (reason.includes("with_failures") || reason.startsWith("failed")) return "failed";
  if (reason.startsWith("complete") || reason.startsWith("settled")) return "done";
  return "stopped";
}

function countsOf(items: readonly LhProgressItem[]): LhProgressRun["counts"] {
  const counts = { total: items.length, done: 0, running: 0, failed: 0, queued: 0 };
  for (const item of items) {
    if (item.status === "done") counts.done += 1;
    else if (item.status === "running") counts.running += 1;
    else if (item.status === "failed" || item.status === "aborted") counts.failed += 1;
    else counts.queued += 1;
  }
  return counts;
}

function itemsFor(mode: RunMode, title: string, input: LhProgressInput, live: boolean): LhProgressItem[] | undefined {
  if (mode === "graph") {
    const g = input.graph;
    if (!g || g.task !== title) return undefined;
    return g.items.slice(0, ITEMS_MAX).map((item) => ({
      id: item.itemId,
      label: clip(item.instruction, LABEL_MAX),
      status: GRAPH_STATUS[item.status],
      deps: [...item.dependsOn],
      wave: item.wave,
      ...(item.summary ? { summary: clip(item.summary, SUMMARY_MAX) } : {}),
      attempts: item.attempts,
    }));
  }
  if (mode === "swarm") {
    const s = input.swarm;
    if (!s || s.task !== title) return undefined;
    return s.items.slice(0, ITEMS_MAX).map((item) => ({
      id: item.itemId,
      label: clip(item.instruction, LABEL_MAX),
      status: SWARM_STATUS[item.status],
      deps: [],
      ...(item.summary ? { summary: clip(item.summary, SUMMARY_MAX) } : {}),
      attempts: item.attempts,
    }));
  }
  if (mode === "ralph") {
    const r = input.ralph;
    if (!r) return undefined;
    // The next `itemsPerIteration` unchecked rows are what this iteration works.
    let slots = live && r.state.status === "active" ? Math.max(1, r.state.itemsPerIteration) : 0;
    return r.checklist.slice(0, ITEMS_MAX).map((row, index) => {
      let status: LhProgressItem["status"] = row.checked ? "done" : "queued";
      if (!row.checked && slots > 0) {
        status = "running";
        slots -= 1;
      }
      return { id: String(index + 1), label: clip(row.text, LABEL_MAX), status, deps: [] };
    });
  }
  return [];
}

function buildRun(
  mode: RunMode,
  title: string,
  status: LhProgressRun["status"],
  reason: string | undefined,
  input: LhProgressInput,
  endedAt?: number,
): LhProgressRun {
  const live = status === "running";
  const items = itemsFor(mode, title, input, live) ?? [];
  const run: LhProgressRun = {
    mode,
    title: clip(title, LABEL_MAX),
    status,
    ...(reason ? { reason } : {}),
    items,
    counts: countsOf(items),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
  if (mode === "ralph" && input.ralph) {
    const r = input.ralph;
    run.ralph = {
      name: r.state.name,
      iteration: r.state.iteration,
      maxIterations: r.state.maxIterations,
      checked: r.checklist.filter((row) => row.checked).length,
      total: r.checklist.length,
    };
  }
  if (mode === "goal" && input.goal) {
    const g = input.goal;
    const est = input.goalEstimate?.goalId === g.goalId ? input.goalEstimate : undefined;
    run.goal = {
      objective: clip(g.objective, 600),
      status: g.status,
      turn: g.turn,
      maxTurns: g.maxTurns,
      ...(g.status === "complete" ? { percent: 100 } : est ? { percent: est.percent } : {}),
      ...(est?.summary ? { summary: clip(est.summary, SUMMARY_MAX) } : g.status === "complete" ? { summary: "Objective met." } : {}),
      ...(est ? { estimatedAt: est.at } : {}),
    };
  }
  return run;
}

/** The pure snapshot (log left empty — see nextProgressLog). */
export function lhProgressSnapshot(input: LhProgressInput): LhProgressEvent {
  const owner = input.owner;
  const current = owner
    ? buildRun(
        modeOfKind(owner.kind),
        owner.label,
        owner.status === "active" ? "running" : "paused",
        owner.status === "parked" ? owner.reason : undefined,
        input,
      )
    : undefined;
  const fin = input.finished;
  const endedAt = fin ? Date.parse(fin.endedAt) : NaN;
  const last = fin
    ? buildRun(modeOfKind(fin.kind), fin.label, finishedStatus(fin.terminalReason), fin.terminalReason, input, Number.isFinite(endedAt) ? endedAt : undefined)
    : undefined;
  return {
    v: 1,
    mode: current && current.status === "running" ? current.mode : "none",
    ...(current ? { current } : {}),
    ...(last ? { last } : {}),
    log: [],
    updatedAt: input.now,
  };
}

const MODE_TITLE: Record<RunMode, string> = { goal: "Goal", ralph: "Ralph", swarm: "Swarm", graph: "Graph" };
const STATUS_WORD: Record<LhProgressItem["status"], string> = {
  queued: "queued",
  ready: "ready",
  running: "running",
  done: "done",
  failed: "failed",
  aborted: "aborted",
};

function sameRun(a: LhProgressRun | undefined, b: LhProgressRun | undefined): boolean {
  return !!a && !!b && a.mode === b.mode && a.title === b.title;
}

/**
 * Log lines for the transition prev → next. Pure: every line is derived from
 * a state change visible elsewhere in the snapshot (run start/end, item
 * status flips, ralph iteration, goal turn / estimate).
 */
export function progressLogLines(prev: LhProgressEvent | undefined, next: LhProgressEvent): LhProgressLogLine[] {
  const at = next.updatedAt;
  const out: LhProgressLogLine[] = [];
  const a = prev?.current;
  const b = next.current;
  if (b && !sameRun(a, b)) {
    const extra = b.items.length > 0 ? ` · ${b.items.length} item${b.items.length === 1 ? "" : "s"}` : "";
    const waves = b.mode === "graph" ? new Set(b.items.map((i) => i.wave ?? 0)).size : 0;
    out.push({ at, text: `${MODE_TITLE[b.mode]} started — ${b.title}${extra}${waves > 0 ? ` in ${waves} wave${waves === 1 ? "" : "s"}` : ""}`, status: b.status });
  } else if (a && b && a.status !== b.status) {
    out.push({ at, text: `${MODE_TITLE[b.mode]} ${b.status === "paused" ? "paused" : "resumed"}${b.reason ? ` (${b.reason})` : ""}`, status: b.status });
  }
  // The run whose items we diff: the current one, or the run that just finished (its last flips still count).
  const ended = a && !sameRun(a, b) && sameRun(next.last, a) ? next.last : undefined;
  const target = b ?? ended;
  if (target) {
    const base = sameRun(a, target) ? a : undefined;
    const before = new Map((base?.items ?? []).map((item) => [item.id, item]));
    for (const item of target.items) {
      const old = before.get(item.id);
      if (old?.status === item.status) continue;
      // New rows (fresh run or added later) log only once they move.
      if (!old && (item.status === "queued" || item.status === "ready")) continue;
      const name = target.mode === "ralph" ? `#${item.id} ${clip(item.label, 48)}` : item.id;
      const tail = (item.status === "done" || item.status === "failed") && item.summary ? ` — ${clip(item.summary, 80)}` : "";
      out.push({ at, text: `${name} ${STATUS_WORD[item.status]}${tail}`, item: item.id, status: item.status });
    }
    if (base?.ralph && target.ralph && base.ralph.iteration !== target.ralph.iteration) {
      out.push({ at, text: `iteration ${target.ralph.iteration}${target.ralph.maxIterations > 0 ? `/${target.ralph.maxIterations}` : ""} · ${target.ralph.checked}/${target.ralph.total} checked`, status: target.status });
    }
    if (target.goal) {
      const og = base?.goal;
      if (og && og.turn !== target.goal.turn) out.push({ at, text: `turn ${target.goal.turn}/${target.goal.maxTurns}`, status: target.status });
      if (target.goal.percent !== undefined && og?.percent !== target.goal.percent) {
        out.push({ at, text: `~${target.goal.percent}%${target.goal.summary ? ` — ${clip(target.goal.summary, 90)}` : ""}`, status: target.status });
      }
    }
  }
  if (a && !sameRun(a, b)) {
    if (ended) {
      const word = ended.status === "done" ? "finished" : ended.status === "failed" ? "finished with failures" : "stopped";
      out.push({ at, text: `${MODE_TITLE[ended.mode]} ${word}${ended.reason ? ` (${ended.reason})` : ""} — ${ended.counts.total > 0 ? `${ended.counts.done}/${ended.counts.total} done` : ended.title}`, status: ended.status });
    } else if (!b) {
      out.push({ at, text: `${MODE_TITLE[a.mode]} ended`, status: "stopped" });
    }
  }
  return out;
}

/** Snapshot + the rolling log carried over from the previous publish. */
export function withProgressLog(prev: LhProgressEvent | undefined, next: LhProgressEvent): LhProgressEvent {
  const lines = progressLogLines(prev, next);
  return { ...next, log: [...(prev?.log ?? []), ...lines].slice(-LOG_MAX) };
}

/** Equality ignoring `updatedAt`/`log` — publish only real changes. */
export function sameProgress(a: LhProgressEvent | undefined, b: LhProgressEvent): boolean {
  if (!a) return false;
  const strip = (e: LhProgressEvent) => JSON.stringify({ ...e, log: undefined, updatedAt: undefined });
  return strip(a) === strip(b);
}
