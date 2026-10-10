/**
 * @pi-unipi/dream — runs: one per staging dir, for the work tray's Dream tab
 * and the app's Dream sheet.
 *
 * Every dream (scheduled or `/unipi:dream run`) gets a staging dir
 * `staging-<startedAt>` with a `run.json` written at launch:
 *   { startedAt, pid, manual, sessions, events, endedAt?, exitCode?, signal?, stopped? }
 * `endedAt`/`exitCode` are filled in by the launching pi when the child
 * exits (it may be gone by then — status then derives from the files):
 *   running   — pid alive (and not past the stale cap)
 *   finished  — DREAM_REPORT.md exists
 *   stopped   — stopped from the tray/app/command, no report
 *   failed    — process gone without a report
 *
 * The trajectory is the child's own session JSONL under `<staging>/sessions/`
 * (pi writes it as it goes) plus `trajectory.log` (stdout/stderr).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "@pi-unipi/core";
import { listProposals, type Proposal } from "./report.ts";
import type { DreamState } from "./schedule.ts";

export type DreamRunStatus = "running" | "finished" | "failed" | "stopped";

export interface RunMeta {
  startedAt: number;
  pid: number;
  manual?: boolean;
  sessions?: number;
  events?: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  stopped?: boolean;
}

export interface DreamRun {
  /** Staging dir basename (`staging-<ms>`) — stable id. */
  id: string;
  staging: string;
  status: DreamRunStatus;
  startedAt: number;
  endedAt?: number;
  pid: number;
  manual: boolean;
  /** Sessions digested (sessions that had struggle events). */
  sessions: number;
  events: number;
  hasReport: boolean;
  proposals: Proposal[];
  pending: number;
  /** Failure detail (exit code / signal / log tail head). */
  error?: string;
}

/** Older stale cap shared with the schedule lock. */
const STALE_MS = 2 * 60 * 60 * 1000;

export function runMetaPath(staging: string): string {
  return path.join(staging, "run.json");
}

export function readRunMeta(staging: string): RunMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(runMetaPath(staging), "utf8")) as Partial<RunMeta>;
    if (typeof raw.startedAt !== "number") return null;
    return { ...raw, startedAt: raw.startedAt, pid: typeof raw.pid === "number" ? raw.pid : -1 } as RunMeta;
  } catch {
    return null;
  }
}

export function writeRunMeta(staging: string, meta: RunMeta): void {
  try {
    fs.writeFileSync(runMetaPath(staging), JSON.stringify(meta, null, 2));
  } catch {
    // best-effort
  }
}

export function patchRunMeta(staging: string, patch: Partial<RunMeta>): void {
  const cur = readRunMeta(staging);
  if (!cur) return;
  writeRunMeta(staging, { ...cur, ...patch });
}

export function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Status of one staging dir (pure over the filesystem + process table). */
export function runFromStaging(staging: string, decisions: DreamState["decisions"] = {}, now = Date.now(), alive: (pid: number) => boolean = pidAlive): DreamRun | null {
  const id = path.basename(staging);
  const fromName = Number(id.replace(/^staging-/, ""));
  const meta = readRunMeta(staging);
  const startedAt = meta?.startedAt ?? (Number.isFinite(fromName) ? fromName : 0);
  if (!startedAt) return null;
  const reportFile = path.join(staging, "DREAM_REPORT.md");
  const hasReport = fs.existsSync(reportFile);
  const pid = meta?.pid ?? -1;
  const live = meta?.endedAt === undefined && now - startedAt < STALE_MS && alive(pid);
  let status: DreamRunStatus;
  if (live) status = "running";
  else if (hasReport) status = "finished";
  else if (meta?.stopped) status = "stopped";
  else status = "failed";
  const endedAt = live
    ? undefined
    : (meta?.endedAt ?? (hasReport ? mtime(reportFile) : undefined) ?? mtime(path.join(staging, "trajectory.log")) ?? startedAt);
  const proposals = hasReport || fs.existsSync(path.join(staging, "proposals")) ? listProposals(staging, decisions) : [];
  let error: string | undefined;
  if (status === "failed") {
    if (meta?.exitCode === 124) error = "timed out (max runtime)";
    else if (typeof meta?.exitCode === "number") error = `exit ${String(meta.exitCode)} without a report`;
    else if (meta?.signal) error = `killed by ${meta.signal}`;
    else error = "ended without a report";
  }
  return {
    id,
    staging,
    status,
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    pid,
    manual: meta?.manual === true,
    sessions: meta?.sessions ?? 0,
    events: meta?.events ?? 0,
    hasReport,
    proposals,
    pending: proposals.filter((p) => p.decision === "pending").length,
    ...(error ? { error } : {}),
  };
}

/** Every run in this workspace, newest first (dismissed ones dropped). */
export function listRuns(cwd: string, state: Pick<DreamState, "decisions"> & { dismissed?: string[] }, now = Date.now()): DreamRun[] {
  let root: string;
  try {
    root = stateDir("dream", "state", cwd);
  } catch {
    return [];
  }
  const dismissed = new Set(state.dismissed ?? []);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((d) => d.startsWith("staging-") && !dismissed.has(d));
  } catch {
    return [];
  }
  const runs: DreamRun[] = [];
  for (const name of names) {
    const run = runFromStaging(path.join(root, name), state.decisions, now);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

/** Stop a running dream: SIGTERM its process group (timeout + pi), then the pid. */
export function stopRun(run: Pick<DreamRun, "pid" | "staging">, kill: (pid: number, sig: NodeJS.Signals) => void = (p, s) => process.kill(p, s)): boolean {
  if (!(run.pid > 0)) return false;
  let ok = false;
  try {
    kill(-run.pid, "SIGTERM");
    ok = true;
  } catch {
    // not a group leader / already gone
  }
  try {
    kill(run.pid, "SIGTERM");
    ok = true;
  } catch {
    // already gone
  }
  patchRunMeta(run.staging, { stopped: true, endedAt: Date.now() });
  return ok;
}

// ── trajectory ────────────────────────────────────────────────────────────

export interface TrajectoryLine {
  kind: "user" | "text" | "tool" | "error" | "result" | "log";
  text: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => (c as { type?: string }).type === "text")
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join(" ");
}

function oneLine(s: string, max = 200): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toolArg(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["command", "path", "file_path", "query", "title", "pattern"]) if (typeof a[k] === "string") return a[k] as string;
  return JSON.stringify(args);
}

/** The child's session JSONL rendered as one-line steps (newest last). */
export function trajectoryFromSession(lines: readonly string[]): TrajectoryLine[] {
  const out: TrajectoryLine[] = [];
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== "message") continue;
    const m = e.message as Record<string, unknown> | undefined;
    if (!m) continue;
    if (m.role === "user") {
      out.push({ kind: "user", text: "dream prompt sent" });
    } else if (m.role === "assistant") {
      for (const c of (Array.isArray(m.content) ? m.content : []) as Array<Record<string, unknown>>) {
        if (c.type === "text" && String(c.text ?? "").trim()) out.push({ kind: "text", text: oneLine(String(c.text)) });
        else if (c.type === "toolCall") out.push({ kind: "tool", text: oneLine(`${String(c.name ?? "tool")} ${toolArg(c.arguments)}`) });
      }
    } else if (m.role === "toolResult") {
      const text = textOf(m.content);
      if (m.isError === true) out.push({ kind: "error", text: oneLine(`${String(m.toolName ?? "tool")} failed: ${text}`) });
    }
  }
  return out;
}

/** Newest session file in `<staging>/sessions/` (pi nests by cwd). */
function newestSessionFile(staging: string): string | undefined {
  const root = path.join(staging, "sessions");
  const found: Array<{ f: string; m: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (ent.name.endsWith(".jsonl")) found.push({ f: p, m: mtime(p) ?? 0 });
    }
  };
  walk(root, 0);
  return found.sort((a, b) => b.m - a.m)[0]?.f;
}

function tailText(file: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Live view of a run: trajectory steps (from the child's session) + the stdout/stderr log tail. */
export function runTrajectory(staging: string, maxLines = 200): { steps: TrajectoryLine[]; log: string[] } {
  const session = newestSessionFile(staging);
  const steps = session ? trajectoryFromSession(tailText(session, 512 * 1024).split("\n").filter(Boolean)) : [];
  const log = tailText(path.join(staging, "trajectory.log"), 32 * 1024)
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return { steps: steps.slice(-maxLines), log: log.slice(-Math.min(maxLines, 80)) };
}

/** The report text (or "" when there is none). */
export function readReport(staging: string): string {
  try {
    return fs.readFileSync(path.join(staging, "DREAM_REPORT.md"), "utf8");
  } catch {
    return "";
  }
}

/** Section sizes from the report markdown: `3 memory edits`, `2 proposals`, `1 skipped`. */
export function summarizeReport(report: string): string[] {
  if (!report.trim()) return [];
  const sections = new Map<string, number>();
  let cur: string | undefined;
  for (const line of report.split("\n")) {
    const h = /^##+\s+(.+)/.exec(line);
    if (h) {
      const name = h[1]!.toLowerCase();
      cur = name.startsWith("memory") ? "memory edit" : name.startsWith("proposal") ? "proposal" : name.startsWith("skipped") ? "skipped" : undefined;
      if (cur) sections.set(cur, 0);
      continue;
    }
    if (cur && /^\s*([-*]|\d+\.)\s+/.test(line)) sections.set(cur, (sections.get(cur) ?? 0) + 1);
  }
  return [...sections].map(([k, n]) => (k === "skipped" ? `${String(n)} skipped` : `${String(n)} ${k}${n === 1 ? "" : "s"}`));
}

/** Summary of a staging dir's report. */
export function reportSummary(staging: string): string[] {
  return summarizeReport(readReport(staging));
}
