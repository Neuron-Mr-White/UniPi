/**
 * @pi-unipi/subagents — Subagent run manager
 *
 * One `ChildAgentRuntime` (shared core) per run: foreground waits with lead-UI
 * approval forwarding; background gets auto-denied prompts; abort → cancelled
 * (resumable from the session file); detach on pending user message (exactly
 * once completion delivery). Max 8 concurrent; process killed at run end.
 * Index persisted to <sessionDir>/index.json on every status change.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ChildAgentRuntime, createCompletionDelivery, type HandoffReport } from "@pi-unipi/core/child-agent.js";
import { stateDir } from "@pi-unipi/core";
import type { AgentProfile } from "./profiles.js";

export const MAX_CONCURRENT = 8;
export const DEPTH_ENV = "UNIPI_SUBAGENT_DEPTH";
export const MAX_DEPTH_ENV = "UNIPI_SUBAGENT_MAX_DEPTH";

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentRecord {
  id: string;
  title: string;
  profile: string;
  model: string;
  status: SubagentStatus;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  lastActivity: number;
  report?: string;
  error?: string;
  sessionFile: string;
  depth: number;
}

export interface SubagentRun {
  record: SubagentRecord;
  runtime: ChildAgentRuntime;
  done: Promise<HandoffReport>;
}

// Shared holder for CP4's panel/footer (same pattern as fusion-status).
const records = new Map<string, SubagentRecord>();
const listeners = new Set<() => void>();

export function getSharedSubagents(): readonly SubagentRecord[] {
  return [...records.values()];
}

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(): void {
  for (const l of listeners) l();
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

export class SubagentManager {
  private readonly runs = new Map<string, SubagentRun>();
  private readonly dirs = new Map<string, string>();
  private activeDir: string | undefined;
  private lastPublishAt = 0;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runtimeFactory?: (opts: Parameters<SubagentManager["spawnRuntime"]>[0]) => ChildAgentRuntime;

  constructor(runtimeFactory?: (opts: Parameters<SubagentManager["spawnRuntime"]>[0]) => ChildAgentRuntime) {
    this.runtimeFactory = runtimeFactory;
  }

  sessionDir(cwd: string, leadSessionId: string): string {
    let dir = this.dirs.get(leadSessionId);
    if (dir === undefined) {
      dir = join(stateDir("subagents", "session", cwd), leadSessionId);
      mkdirSync(dir, { recursive: true });
      this.dirs.set(leadSessionId, dir);
    }
    this.activeDir = dir;
    return dir;
  }

  /** Load persisted records on session_start; running entries → failed. */
  restore(cwd: string, leadSessionId: string): void {
    records.clear();
    const dir = this.sessionDir(cwd, leadSessionId);
    const indexPath = join(dir, "index.json");
    if (!existsSync(indexPath)) return;
    try {
      const list = JSON.parse(readFileSync(indexPath, "utf8")) as SubagentRecord[];
      for (const rec of list) {
        if (rec.status === "running") {
          records.set(rec.id, { ...rec, status: "failed", error: "interrupted by reload", endedAt: Date.now() });
        } else {
          records.set(rec.id, rec);
        }
      }
      this.persist();
      publish();
    } catch {
      /* corrupt index — start fresh */
    }
  }

  private persist(): void {
    if (this.activeDir === undefined) return;
    const indexPath = join(this.activeDir, "index.json");
    const tmp = `${indexPath}.tmp-${String(process.pid)}`;
    writeFileSync(tmp, JSON.stringify([...records.values()], null, 2), "utf8");
    renameSync(tmp, indexPath);
  }

  /** Status-changing update: record, persist index.json, publish now. */
  private set(record: SubagentRecord, patch: Partial<SubagentRecord>): void {
    Object.assign(record, patch, { lastActivity: Date.now() });
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

  /** Resolve a report without waiting (snapshot for read_subagent block:false). */
  report(id: string): HandoffReport | undefined {
    return this.runs.get(id)?.runtime.reports.get(id);
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
    onStep?: () => void;
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
      onProgress: opts.onStep,
      onStep: opts.onStep,
    });
  }


  /**
   * Start a run. `existing` (resume) reuses the old session file so the child
   * keeps its context; a fresh run gets a new file and record.
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
    onDone?: (run: SubagentRun, report: HandoffReport) => void;
  }): { run: SubagentRun } | { error: string } {
    if (opts.resume !== undefined && this.runs.has(opts.resume)) {
      return { error: `Subagent ${opts.resume} is still running — use read_subagent to wait for it.` };
    }
    if (opts.resume === undefined && this.runs.size >= MAX_CONCURRENT) {
      return { error: `Maximum ${String(MAX_CONCURRENT)} concurrent subagents running — wait for one to finish or read_subagent first.` };
    }
    const parentDepth = currentDepth();
    const id = opts.resume ?? newAgentId();
    const record: SubagentRecord = {
      id,
      title: opts.title,
      profile: opts.profile.id,
      model: opts.model,
      status: "running",
      background: opts.background,
      startedAt: Date.now(),
      toolCalls: 0,
      lastActivity: Date.now(),
      sessionFile: join(this.sessionDir(opts.cwd, opts.leadSessionId), `${id}.jsonl`),
      depth: parentDepth + 1,
    };
    const prev = opts.resume === undefined ? undefined : records.get(opts.resume);
    if (opts.resume !== undefined && prev === undefined) {
      return { error: `No subagent found for ${opts.resume} — can't resume.` };
    }
    if (prev !== undefined) record.depth = prev.depth;

    const runtime = this.spawnRuntime({
      sessionFile: record.sessionFile,
      cwd: opts.cwd,
      model: opts.model,
      thinking: opts.thinking,
      systemPrompt: opts.profile.systemPrompt,
      extraArgs: opts.profile.tools !== undefined
        ? ["--tools", opts.profile.tools.join(",")]
        : ["--exclude-tools", "sidekick,read_subagent,run_subagent"],
      title: opts.title,
      depth: record.depth,
      // Default: no nesting (child's DEPTH >= MAX_DEPTH → no run_subagent).
      // A custom profile's max-nesting grants exactly that many levels.
      maxDepth: Math.max(1, record.depth + (opts.profile.maxNesting ?? 0)),
      onStep: () => {
        const r = records.get(id);
        if (r === undefined) return;
        // toolCalls comes from the runtime's own counter (steps, not deltas);
        // activity bumps are memory-only — index.json writes on status changes.
        this.touch(r, { toolCalls: runtime.progress(id)?.toolCalls ?? r.toolCalls });
      },
    });
    const handoff = runtime.handoff(opts.task);
    const run: SubagentRun = { record, runtime, done: handoff.done };
    this.runs.set(id, run);
    records.set(id, record);
    this.persist();
    publish();

    handoff.done
      .then((report) => {
        this.set(record, {
          status: report.status === "completed" ? "completed" : report.status === "aborted" || report.status === "interrupted" ? "cancelled" : "failed",
          endedAt: Date.now(),
          toolCalls: report.toolCalls,
          report: report.text,
          error: report.error,
        });
        this.runs.delete(id);
        runtime.kill(); // respawns on resume from the session file
        opts.onDone?.(run, report);
      })
      .catch((error) => {
        this.set(record, { status: "failed", endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
        this.runs.delete(id);
        runtime.kill();
      });
    return { run };
  }

  abort(id: string): void {
    const run = this.runs.get(id);
    if (run) void run.runtime.abort();
  }

  abortAll(): void {
    for (const run of this.runs.values()) void run.runtime.abort();
    for (const run of this.runs.values()) run.runtime.kill();
    this.runs.clear();
  }
}

export { createCompletionDelivery };
