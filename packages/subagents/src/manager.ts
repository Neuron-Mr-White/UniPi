/**
 * @pi-unipi/subagents — Subagent run manager
 *
 * One `ChildAgentRuntime` (shared core) per run: foreground waits with lead-UI
 * approval forwarding; background gets auto-denied prompts; abort → cancelled
 * (resumable from the session file); detach on pending user message (exactly
 * once completion delivery). Concurrency capped; process killed at run end.
 * Index persisted to <state>/subagents/sessions/<leadSessionId>/index.json on
 * every status change — keyed by the lead's session id (not the process), so
 * the panel survives a restart + resume.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ChildAgentRuntime, createCompletionDelivery, type HandoffReport, type SidekickEvent } from "@pi-unipi/core/child-agent.js";
import { stateDir } from "@pi-unipi/core";
import type { AgentProfile } from "./profiles.js";

export const MAX_CONCURRENT = 8;
export const DEPTH_ENV = "UNIPI_SUBAGENT_DEPTH";
export const MAX_DEPTH_ENV = "UNIPI_SUBAGENT_MAX_DEPTH";
/** A cancel the child doesn't honour within this window is forced (kill). */
export const CANCEL_GRACE_MS = 5000;
const MAX_TASK_CHARS = 20_000;

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentRecord {
  id: string;
  title: string;
  profile: string;
  model: string;
  thinking?: string;
  status: SubagentStatus;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  lastActivity: number;
  /** The task prompt of the latest run (shown in the transcript view). */
  task?: string;
  report?: string;
  error?: string;
  /** Who cancelled it — "user" (dock x / Esc) or "session" (shutdown). */
  cancelledBy?: "user" | "session";
  sessionFile: string;
  depth: number;
}

export interface SubagentRun {
  record: SubagentRecord;
  runtime: ChildAgentRuntime;
  done: Promise<HandoffReport>;
}

// Shared holder for the panel/strip (same pattern as fusion-status).
const records = new Map<string, SubagentRecord>();
const listeners = new Set<() => void>();

export function getSharedSubagents(): readonly SubagentRecord[] {
  return [...records.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Arbiter wait-source reason (lead only): a background run still in flight, or null. */
export function backgroundRunningReason(all: readonly SubagentRecord[]): string | null {
  return all.some((record) => record.background && record.status === "running")
    ? "background subagent running"
    : null;
}

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a broken listener must not break the run */
    }
  }
}

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  return parseInt(env[DEPTH_ENV] ?? "0", 10) || 0;
}

export function canSpawn(env: NodeJS.ProcessEnv = process.env): boolean {
  const depth = currentDepth(env);
  const max = parseInt(env[MAX_DEPTH_ENV] ?? "1", 10) || 1;
  return depth < max;
}

function newAgentId(): string {
  return randomBytes(4).toString("hex");
}

/** Report status → record status. A user/session cancel wins over the
 *  "error" a forced kill produces. */
export function recordStatusFor(report: Pick<HandoffReport, "status">, cancelledBy?: SubagentRecord["cancelledBy"]): SubagentStatus {
  if (report.status === "completed") return "completed";
  if (report.status === "aborted" || report.status === "interrupted" || cancelledBy !== undefined) return "cancelled";
  return "failed";
}

export class SubagentManager {
  private readonly runs = new Map<string, SubagentRun>();
  /** Finished runs' events for this process (the view falls back to the
   *  session file after a restart). */
  private readonly finishedEvents = new Map<string, SidekickEvent[]>();
  private activeDir: string | undefined;
  private lastPublishAt = 0;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runtimeFactory?: (opts: Parameters<SubagentManager["spawnRuntime"]>[0]) => ChildAgentRuntime;

  constructor(runtimeFactory?: (opts: Parameters<SubagentManager["spawnRuntime"]>[0]) => ChildAgentRuntime) {
    this.runtimeFactory = runtimeFactory;
  }

  sessionDir(cwd: string, leadSessionId: string): string {
    const dir = join(stateDir("subagents", "state", cwd), "sessions", leadSessionId);
    mkdirSync(dir, { recursive: true });
    this.activeDir = dir;
    return dir;
  }

  /** Load persisted records on session_start; running entries → failed. */
  restore(cwd: string, leadSessionId: string): void {
    records.clear();
    this.finishedEvents.clear();
    const dir = this.sessionDir(cwd, leadSessionId);
    const indexPath = join(dir, "index.json");
    if (!existsSync(indexPath)) {
      publish();
      return;
    }
    try {
      const list = JSON.parse(readFileSync(indexPath, "utf8")) as SubagentRecord[];
      for (const rec of list) {
        records.set(rec.id, rec.status === "running"
          ? { ...rec, status: "failed", error: "interrupted — pi exited while it ran", endedAt: rec.lastActivity }
          : rec);
      }
      this.persist();
    } catch {
      /* corrupt index — start fresh */
    }
    publish();
  }

  private persist(): void {
    if (this.activeDir === undefined) return;
    try {
      const indexPath = join(this.activeDir, "index.json");
      const tmp = `${indexPath}.tmp-${String(process.pid)}`;
      writeFileSync(tmp, JSON.stringify([...records.values()], null, 2), "utf8");
      renameSync(tmp, indexPath);
    } catch {
      /* the in-memory panel stays correct; next write retries */
    }
  }

  /** Status-changing update: record, persist index.json, publish now. */
  private set(record: SubagentRecord, patch: Partial<SubagentRecord>): void {
    Object.assign(record, patch, { lastActivity: Date.now() });
    if (records.get(record.id) !== record) return; // a stale run from a previous session
    this.persist();
    this.publishNow();
  }

  /** Cheap activity bump (steps/deltas): no disk write, throttled publish. */
  private touch(record: SubagentRecord, patch: Partial<SubagentRecord>): void {
    Object.assign(record, patch, { lastActivity: Date.now() });
    const now = Date.now();
    if (now - this.lastPublishAt >= 250) {
      this.publishNow();
    } else if (this.publishTimer === undefined) {
      this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined;
        this.publishNow();
      }, 260 - (now - this.lastPublishAt));
      this.publishTimer.unref?.();
    }
  }

  private publishNow(): void {
    this.lastPublishAt = Date.now();
    publish();
  }

  runningCount(): number {
    return this.runs.size;
  }

  record(id: string): SubagentRecord | undefined {
    return records.get(id);
  }

  latest(): { id: string; startedAt: number } | undefined {
    let best: { id: string; startedAt: number } | undefined;
    for (const rec of records.values()) {
      if (best === undefined || rec.startedAt > best.startedAt) best = { id: rec.id, startedAt: rec.startedAt };
    }
    return best;
  }

  run(id: string): SubagentRun | undefined {
    return this.runs.get(id);
  }

  /** Live events of a running agent, or this process's events of a finished one. */
  events(id: string): SidekickEvent[] | undefined {
    const run = this.runs.get(id);
    if (run !== undefined) return run.runtime.progress()?.events;
    return this.finishedEvents.get(id);
  }

  /** Live tool-call count (running) or the recorded one. */
  toolCalls(id: string): number {
    const run = this.runs.get(id);
    return run?.runtime.progress()?.toolCalls ?? records.get(id)?.toolCalls ?? 0;
  }

  /** Mark a run foreground/background (UI + approval routing done by caller). */
  setBackground(id: string, background: boolean): void {
    const rec = records.get(id);
    if (rec !== undefined && rec.background !== background) this.set(rec, { background });
  }

  private spawnRuntime(opts: {
    sessionFile: string;
    cwd: string;
    model: string;
    thinking: string;
    systemPrompt: string;
    extraArgs: string[];
    title: string;
    depth: number;
    maxDepth: number;
    onProgress?: () => void;
  }): ChildAgentRuntime {
    if (this.runtimeFactory !== undefined) return this.runtimeFactory(opts);
    return new ChildAgentRuntime({
      cwd: opts.cwd,
      model: opts.model as never,
      thinking: opts.thinking as never,
      sessionFile: opts.sessionFile,
      systemPrompt: opts.systemPrompt,
      extraArgs: opts.extraArgs,
      extraEnv: {
        [DEPTH_ENV]: String(opts.depth),
        [MAX_DEPTH_ENV]: String(opts.maxDepth),
      },
      promptPrefix: `Subagent "${opts.title}": `,
      onProgress: opts.onProgress,
    });
  }

  /**
   * Start a run. `resume` reuses the old session file so the child keeps its
   * context; a fresh run gets a new file and record.
   */
  start(opts: {
    title: string;
    task: string;
    profile: AgentProfile;
    model: string;
    thinking: string;
    cwd: string;
    leadSessionId: string;
    background: boolean;
    resume?: string;
    maxConcurrent?: number;
    onDone?: (run: SubagentRun, report: HandoffReport) => void;
  }): { run: SubagentRun } | { error: string } {
    const max = opts.maxConcurrent ?? MAX_CONCURRENT;
    if (opts.resume !== undefined && this.runs.has(opts.resume)) {
      return { error: `Subagent ${opts.resume} is still running — use read_subagent to wait for it.` };
    }
    if (this.runs.size >= max) {
      return { error: `Maximum ${String(max)} concurrent subagents running — wait for one to finish (read_subagent) before starting another.` };
    }
    const prev = opts.resume === undefined ? undefined : records.get(opts.resume);
    if (opts.resume !== undefined && prev === undefined) {
      return { error: `No subagent found for ${opts.resume} — can't resume.` };
    }
    const id = opts.resume ?? newAgentId();
    const record: SubagentRecord = {
      id,
      title: opts.title || prev?.title || id,
      profile: opts.profile.id,
      model: opts.model,
      thinking: opts.thinking,
      status: "running",
      background: opts.background,
      startedAt: Date.now(),
      toolCalls: 0,
      lastActivity: Date.now(),
      task: opts.task.length > MAX_TASK_CHARS ? `${opts.task.slice(0, MAX_TASK_CHARS)}…` : opts.task,
      sessionFile: prev?.sessionFile ?? join(this.sessionDir(opts.cwd, opts.leadSessionId), `${id}.jsonl`),
      depth: prev?.depth ?? currentDepth() + 1,
    };

    const runtime = this.spawnRuntime({
      sessionFile: record.sessionFile,
      cwd: opts.cwd,
      model: opts.model,
      thinking: opts.thinking,
      systemPrompt: opts.profile.systemPrompt,
      extraArgs: opts.profile.tools !== undefined
        ? ["--tools", opts.profile.tools.join(",")]
        : ["--exclude-tools", "sidekick,read_subagent,run_subagent"],
      title: record.title,
      depth: record.depth,
      // Default: no nesting (child's DEPTH >= MAX_DEPTH → no run_subagent).
      // A custom profile's max-nesting grants exactly that many levels.
      maxDepth: Math.max(1, record.depth + (opts.profile.maxNesting ?? 0)),
      onProgress: () => {
        const r = records.get(id);
        if (r === undefined) return;
        // Activity bumps are memory-only — index.json writes on status changes.
        this.touch(r, { toolCalls: runtime.progress()?.toolCalls ?? r.toolCalls });
      },
    });
    const handoff = runtime.handoff(opts.task);
    // Reports carry the subagent id, not the runtime's per-handoff id — every
    // consumer (completion notice, read_subagent, resume) speaks agent ids.
    const done = handoff.done.then((report) => ({ ...report, id }));
    const run: SubagentRun = { record, runtime, done };
    this.runs.set(id, run);
    this.finishedEvents.delete(id);
    records.set(id, record);
    this.persist();
    this.publishNow();

    const settle = (patch: Partial<SubagentRecord>, events: SidekickEvent[] | undefined) => {
      if (this.runs.get(id) === run) this.runs.delete(id);
      if (events !== undefined) this.finishedEvents.set(id, events);
      this.set(record, { endedAt: Date.now(), ...patch });
      runtime.kill(); // respawns on resume from the session file
    };
    done
      .then((report) => {
        settle({
          status: recordStatusFor(report, record.cancelledBy),
          toolCalls: report.toolCalls,
          report: report.text,
          error: report.error,
        }, report.events);
        opts.onDone?.(run, report);
      })
      .catch((error) => {
        settle({ status: record.cancelledBy !== undefined ? "cancelled" : "failed", error: error instanceof Error ? error.message : String(error) }, undefined);
      });
    return { run };
  }

  /**
   * Cancel a running agent. The child gets an abort; if it hasn't settled
   * within CANCEL_GRACE_MS the process is killed (the run then settles as
   * cancelled, not failed). Returns false when it isn't running.
   */
  cancel(id: string, by: "user" | "session" = "user"): boolean {
    const run = this.runs.get(id);
    if (run === undefined) return false;
    run.record.cancelledBy = by;
    this.publishNow();
    void run.runtime.abort().catch(() => undefined);
    const timer = setTimeout(() => {
      if (this.runs.get(id) === run) run.runtime.kill();
    }, CANCEL_GRACE_MS);
    timer.unref?.();
    return true;
  }

  /** Back-compat alias used by the foreground Esc path. */
  abort(id: string): void {
    this.cancel(id, "user");
  }

  /** Session end: running agents are recorded as cancelled (persisted before
   *  the processes go), then killed. */
  shutdown(): void {
    for (const run of this.runs.values()) {
      Object.assign(run.record, { status: "cancelled", cancelledBy: "session", endedAt: Date.now(), error: "session ended while it ran" });
    }
    this.persist();
    const live = [...this.runs.values()];
    this.runs.clear();
    for (const run of live) {
      void run.runtime.abort().catch(() => undefined);
      run.runtime.kill();
    }
    this.publishNow();
  }

  /** @deprecated use shutdown() */
  abortAll(): void {
    this.shutdown();
  }
}

export { createCompletionDelivery };
