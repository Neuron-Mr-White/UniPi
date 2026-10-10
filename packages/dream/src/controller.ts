/**
 * @pi-unipi/dream — the one controller every surface shares: the
 * `/unipi:dream` command, the work tray's Dream tab and the app bridge
 * (published UI-free on globalThis under `Symbol.for("unipi.dream.api")`,
 * so app-bridge never imports this package).
 *
 * Runs are read from disk (src/runs.ts). A cheap change signal fires on
 * every action, when a child this pi started exits, and — only while a
 * listener is subscribed AND a run is running — on a 2 s poll of the
 * status signature. Idle sessions pay nothing.
 */

import * as path from "node:path";
import { getSettings, unipiRoot } from "@pi-unipi/core";
import { normalizeDream, type DreamSettings } from "./settings.ts";
import { countNewSessions, sessionDirFor } from "./digest.ts";
import { isDue, readDreamState, writeDreamState, type DueResult } from "./schedule.ts";
import { craftSkillDir, startDream, type DreamLaunch } from "./runner.ts";
import { approveCheck, approveSkill, type Proposal } from "./report.ts";
import { listRuns, readReport, reportSummary, runTrajectory, stopRun, type DreamRun, type TrajectoryLine } from "./runs.ts";

export const DREAM_API_KEY = Symbol.for("unipi.dream.api");

/** Same project-name rule as @unipi/memory (documented in its paths.ts). */
export function memoryRootFor(cwd: string): string {
  const project =
    path
      .basename(cwd)
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "unknown";
  return path.join(unipiRoot(), "memory", project);
}

// ── wire shapes (docs/m5/PROTOCOL.md §9) ───────────────────────────────────

export interface DreamProposalInfo {
  id: string;
  name: string;
  kind: "skill" | "check";
  decision: "pending" | "approved" | "rejected";
}

export interface DreamRunInfo {
  id: string;
  status: DreamRun["status"];
  startedAt: number;
  endedAt?: number;
  manual: boolean;
  sessions: number;
  events: number;
  pending: number;
  hasReport: boolean;
  proposals: DreamProposalInfo[];
  summary?: string[];
  error?: string;
}

export interface DreamStatusInfo {
  v: 1;
  /** Background dreaming on (settings `dream.enabled`). Manual runs work either way. */
  enabled: boolean;
  /** When on: is one due at the next pi open, and why (not). */
  due?: { due: boolean; reason: string };
  minSessions: number;
  minGapHours: number;
  lastRunAt: number;
  running: boolean;
  /** Newest first, ≤ 20. */
  runs: DreamRunInfo[];
}

export interface DreamRunDetail {
  id: string;
  report: string;
  steps: TrajectoryLine[];
  log: string[];
}

export type DreamActionResult = { ok: true; message: string } | { ok: false; message: string };

export interface DreamApi {
  status(): DreamStatusInfo;
  runs(): DreamRun[];
  detail(id: string): DreamRunDetail | undefined;
  run(): DreamActionResult;
  stop(id?: string): DreamActionResult;
  approve(runId: string, proposalId: string): DreamActionResult;
  reject(runId: string, proposalId: string): DreamActionResult;
  dismiss(runId: string): DreamActionResult;
  subscribe(listener: () => void): () => void;
}

export function proposalInfo(p: Proposal): DreamProposalInfo {
  return { id: p.id, name: p.name, kind: p.kind, decision: p.decision };
}

export function runInfo(r: DreamRun): DreamRunInfo {
  const summary = r.hasReport ? reportSummary(r.staging) : [];
  return {
    id: r.id,
    status: r.status,
    startedAt: r.startedAt,
    ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    manual: r.manual,
    sessions: r.sessions,
    events: r.events,
    pending: r.pending,
    hasReport: r.hasReport,
    proposals: r.proposals.map(proposalInfo),
    ...(summary.length ? { summary } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export interface ControllerDeps {
  cwd: () => string;
  settings?: (cwd: string) => DreamSettings;
  start?: typeof startDream;
  now?: () => number;
}

export class DreamController implements DreamApi {
  private readonly listeners = new Set<() => void>();
  private poll: ReturnType<typeof setInterval> | undefined;
  private lastSig = "";
  private cache: { at: number; cwd: string; runs: DreamRun[] } | undefined;

  constructor(private readonly deps: ControllerDeps) {}

  private get cwd(): string {
    return this.deps.cwd();
  }

  settings(): DreamSettings {
    return this.deps.settings ? this.deps.settings(this.cwd) : normalizeDream(getSettings("dream", this.cwd));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Runs, cached for 1 s (the tray reads counts every frame). */
  runs(): DreamRun[] {
    const now = this.now();
    if (this.cache && this.cache.cwd === this.cwd && now - this.cache.at < 1000) return this.cache.runs;
    const runs = listRuns(this.cwd, readDreamState(this.cwd), now);
    this.cache = { at: now, cwd: this.cwd, runs };
    return runs;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  status(): DreamStatusInfo {
    const cfg = this.settings();
    const state = readDreamState(this.cwd);
    const runs = this.runs();
    let due: DueResult | undefined;
    if (cfg.enabled) {
      try {
        due = isDue(state, countNewSessions(sessionDirFor(this.cwd), state.lastRunAt), cfg, this.now());
      } catch {
        due = undefined;
      }
    }
    return {
      v: 1,
      enabled: cfg.enabled,
      ...(due ? { due: { due: due.due, reason: due.reason } } : {}),
      minSessions: cfg.minSessions,
      minGapHours: cfg.minGapHours,
      lastRunAt: state.lastRunAt,
      running: runs.some((r) => r.status === "running"),
      runs: runs.slice(0, 20).map(runInfo),
    };
  }

  detail(id: string): DreamRunDetail | undefined {
    const run = this.runs().find((r) => r.id === id);
    if (!run) return undefined;
    const t = runTrajectory(run.staging);
    return { id, report: readReport(run.staging), steps: t.steps, log: t.log };
  }

  /** Start a dream now (allowed while background dreaming is off). */
  run(opts: { manual?: boolean } = {}): DreamActionResult & { launch?: DreamLaunch } {
    this.invalidate();
    const running = this.runs().find((r) => r.status === "running");
    if (running) return { ok: false, message: `A dream is already running (pid ${String(running.pid)}).` };
    const cfg = this.settings();
    const state = readDreamState(this.cwd);
    const start = this.deps.start ?? startDream;
    const launch = start(this.cwd, cfg, memoryRootFor(this.cwd), {
      manual: opts.manual !== false,
      onExit: () => {
        this.invalidate();
        this.emit();
      },
    });
    if (!launch) return { ok: false, message: "Couldn't start the dream child (see the dream state dir)." };
    writeDreamState(this.cwd, { ...state, lastRunAt: this.now(), lock: { pid: launch.pid, at: this.now() }, shownReport: null });
    this.invalidate();
    this.emit();
    return { ok: true, message: `Dream running in the background (pid ${String(launch.pid)}, ${String(launch.sessions)} sessions digested).`, launch };
  }

  stop(id?: string): DreamActionResult {
    this.invalidate();
    const run = this.runs().find((r) => r.status === "running" && (id === undefined || r.id === id));
    if (!run) return { ok: false, message: "No dream is running." };
    stopRun(run);
    const state = readDreamState(this.cwd);
    if (state.lock?.pid === run.pid) writeDreamState(this.cwd, { ...state, lock: null });
    this.invalidate();
    this.emit();
    return { ok: true, message: "Dream stopped." };
  }

  private findProposal(runId: string, proposalId: string): { run: DreamRun; proposal: Proposal } | undefined {
    this.invalidate();
    const run = this.runs().find((r) => r.id === runId);
    const proposal = run?.proposals.find((p) => p.id === proposalId);
    return run && proposal ? { run, proposal } : undefined;
  }

  approve(runId: string, proposalId: string): DreamActionResult {
    const hit = this.findProposal(runId, proposalId);
    if (!hit) return { ok: false, message: "That proposal no longer exists." };
    if (hit.proposal.decision !== "pending") return { ok: false, message: `${hit.proposal.name} is already ${hit.proposal.decision}.` };
    const cfg = this.settings();
    const result =
      hit.proposal.kind === "skill"
        ? approveSkill(hit.proposal, path.resolve(this.cwd, cfg.skillsTarget), path.join(craftSkillDir(), "scripts"))
        : approveCheck(hit.proposal);
    if (result.ok) {
      const state = readDreamState(this.cwd);
      state.decisions[proposalId] = "approved";
      writeDreamState(this.cwd, state);
    }
    this.invalidate();
    this.emit();
    return result.ok ? { ok: true, message: `Approved ${hit.proposal.name}. ${result.detail}`.trim() } : { ok: false, message: `Approval failed (not recorded): ${result.detail}` };
  }

  reject(runId: string, proposalId: string): DreamActionResult {
    const hit = this.findProposal(runId, proposalId);
    if (!hit) return { ok: false, message: "That proposal no longer exists." };
    if (hit.proposal.decision !== "pending") return { ok: false, message: `${hit.proposal.name} is already ${hit.proposal.decision}.` };
    const state = readDreamState(this.cwd);
    state.decisions[proposalId] = "rejected";
    writeDreamState(this.cwd, state);
    this.invalidate();
    this.emit();
    return { ok: true, message: `Rejected ${hit.proposal.name}.` };
  }

  dismiss(runId: string): DreamActionResult {
    this.invalidate();
    const run = this.runs().find((r) => r.id === runId);
    if (!run) return { ok: false, message: "That dream is gone." };
    if (run.status === "running") return { ok: false, message: "That dream is still running — stop it first." };
    const state = readDreamState(this.cwd);
    writeDreamState(this.cwd, { ...state, dismissed: [...new Set([...(state.dismissed ?? []), runId])] });
    this.invalidate();
    this.emit();
    return { ok: true, message: "Dismissed." };
  }

  // ── change signal ──────────────────────────────────────────────────────

  private signature(): string {
    return this.runs()
      .map((r) => `${r.id}:${r.status}:${String(r.pending)}:${String(r.hasReport)}`)
      .join("|");
  }

  emit(): void {
    try {
      this.lastSig = this.signature();
    } catch {
      /* fs hiccup */
    }
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a broken listener never breaks the others */
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.poll) {
      try {
        this.lastSig = this.signature();
      } catch {
        this.lastSig = "";
      }
      this.poll = setInterval(() => {
        try {
          // Only a running dream can change by itself.
          if (!this.cache?.runs.some((r) => r.status === "running") && this.lastSig.indexOf(":running:") < 0) return;
          this.invalidate();
          const sig = this.signature();
          if (sig !== this.lastSig) this.emit();
          else for (const l of [...this.listeners]) l();
        } catch {
          /* never throw from a timer */
        }
      }, 2000);
      this.poll.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.poll) {
        clearInterval(this.poll);
        this.poll = undefined;
      }
    };
  }

  dispose(): void {
    this.listeners.clear();
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }
}

/** Publish the controller for app-bridge (duck-typed reader). */
export function publishDreamApi(api: DreamApi | undefined): void {
  const g = globalThis as unknown as Record<symbol, unknown>;
  if (api) g[DREAM_API_KEY] = api;
  else delete g[DREAM_API_KEY];
}
