/**
 * @pi-unipi/subagents — Retained children + resume
 *
 * Ported from pi-subagents src/runs/background/retained-children.ts (core).
 * Completed workflow children from the current parent session stay
 * addressable: children.list shows up to 10 (newest first, a resumable child
 * retained when available) with explicit resumable/not-resumable state.
 * Resume only rows reported resumable; the revived child keeps its stored
 * agent/model/tool contract and gets the follow-up task.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR } from "./parity-types.js";
import { readStatus } from "./async-runner.js";

const MAX_RETAINED_CHILDREN = 10;
const MAX_RETAINED_CHILD_CANDIDATES = 100;
const MAX_TASK_SUMMARY_LENGTH = 120;

export type RetainedChildState = "completed" | "failed" | "paused" | "stopped";

export type RetainedChildResumability =
  | { state: "resumable"; sessionPath: string }
  | { state: "not-resumable"; reason: string };

export interface RetainedChild {
  runId: string;
  state: RetainedChildState;
  agent: string;
  taskSummary: string;
  completedAt: number;
  resumability: RetainedChildResumability;
  sessionPath?: string;
}

function isRetainedChildState(state: unknown): state is RetainedChildState {
  return state === "completed" || state === "failed" || state === "paused" || state === "stopped";
}

function retainedSessionFile(sessionFile: string | undefined): RetainedChildResumability {
  if (!sessionFile) return { state: "not-resumable", reason: "no persisted session file" };
  if (!sessionFile.endsWith(".jsonl")) return { state: "not-resumable", reason: "persisted session file is not a .jsonl file" };
  try {
    const stat = fs.lstatSync(sessionFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: "not-resumable", reason: "persisted session file is not a regular file" };
    return { state: "resumable", sessionPath: sessionFile };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "not-resumable", reason: `persisted session file is missing: ${sessionFile}` };
    }
    return { state: "not-resumable", reason: `persisted session file could not be inspected: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function boundedTaskSummary(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > MAX_TASK_SUMMARY_LENGTH ? `${normalized.slice(0, MAX_TASK_SUMMARY_LENGTH - 1)}…` : normalized;
}

/** List terminal async runs from this session with their resumability. */
export function listRetainedChildren(asyncDirRoot: string = ASYNC_DIR, sessionId?: string): RetainedChild[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(asyncDirRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const children: RetainedChild[] = [];
  for (const entry of entries.slice(0, MAX_RETAINED_CHILD_CANDIDATES)) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(asyncDirRoot, entry.name);
    const status = readStatus(runDir);
    if (!isRetainedChildState(status.status)) continue;
    if (sessionId && status.sessionId !== sessionId) continue;

    const completedAt =
      typeof status.updatedAt === "number" ? status.updatedAt : statMtime(runDir);
    if (completedAt === undefined) continue;

    // Reference rule: stopped runs are never resumable.
    if (status.status === "stopped") {
      const agent = typeof status.agent === "string" ? status.agent : "unknown";
      const completedAt2 = typeof status.updatedAt === "number" ? status.updatedAt : statMtime(runDir);
      if (completedAt2 === undefined) continue;
      children.push({
        runId: entry.name,
        state: "stopped",
        agent,
        taskSummary: boundedTaskSummary(typeof status.task === "string" ? status.task : undefined),
        completedAt: completedAt2,
        resumability: { state: "not-resumable", reason: "stopped run" },
      });
      continue;
    }

    const agent = typeof status.agent === "string" ? status.agent : "unknown";
    const taskSummary = boundedTaskSummary(typeof status.task === "string" ? status.task : undefined);
    const resumability = retainedSessionFile(
      typeof status.sessionFile === "string" ? status.sessionFile : undefined,
    );

    children.push({
      runId: entry.name,
      state: status.status,
      agent,
      taskSummary,
      completedAt,
      resumability,
      ...(resumability.state === "resumable" ? { sessionPath: resumability.sessionPath } : {}),
    });
  }

  return children.sort((left, right) => right.completedAt - left.completedAt);
}

function statMtime(dir: string): number | undefined {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
}

export function formatRetainedChildren(children: RetainedChild[]): string {
  if (children.length === 0) {
    return "No retained workflow children in the active parent session. If a retained-writer challenge is required, launch a same-role fallback challenge and label it as fallback.";
  }
  const retained = children.slice(0, MAX_RETAINED_CHILDREN);
  if (!retained.some((child) => child.resumability.state === "resumable")) {
    const resumable = children.slice(MAX_RETAINED_CHILDREN).find((child) => child.resumability.state === "resumable");
    if (resumable && retained.length === MAX_RETAINED_CHILDREN) retained[MAX_RETAINED_CHILDREN - 1] = resumable;
  }
  const hasResumableChild = retained.some((child) => child.resumability.state === "resumable");
  return [
    `Retained workflow children (up to ${MAX_RETAINED_CHILDREN}; newest first, with a resumable child retained when available):`,
    ...retained.flatMap((child) => [
      `- ${child.runId} | ${child.agent} | ${child.state} | ${new Date(child.completedAt).toISOString()}`,
      `  task: ${child.taskSummary || "(no task summary)"}`,
      child.resumability.state === "resumable"
        ? "  resumability: resumable"
        : `  resumability: not resumable (${child.resumability.reason})`,
      ...(child.resumability.state === "resumable"
        ? [
            `  session: ${child.resumability.sessionPath}`,
            `  resume: spawn_helper({ action: "resume", id: "${child.runId}", message: "..." })`,
          ]
        : []),
    ]),
    ...(hasResumableChild ? [] : ["No resumable retained child is listed. Launch a same-role fallback challenge and label it as fallback."]),
  ].join("\n");
}

/**
 * Resolve a resume target: only rows reported resumable may resume. Returns
 * the stored contract (agent name + session file) or an error message.
 */
export function resolveResumeTarget(
  asyncDirRoot: string,
  runIdOrPrefix: string,
): { ok: true; runId: string; agent: string; sessionFile: string } | { ok: false; error: string } {
  const children = listRetainedChildren(asyncDirRoot);
  const matches = children.filter((child) => child.runId.startsWith(runIdOrPrefix));
  if (matches.length === 0) {
    return { ok: false, error: `No retained child matches "${runIdOrPrefix}". Use children.list to see retained runs.` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `"${runIdOrPrefix}" matches ${matches.length} retained children; use a longer prefix.` };
  }
  const target = matches[0]!;
  if (target.resumability.state !== "resumable") {
    return { ok: false, error: `Run ${target.runId} is not resumable (${target.resumability.reason}).` };
  }
  return { ok: true, runId: target.runId, agent: target.agent, sessionFile: target.resumability.sessionPath };
}
