/**
 * @pi-unipi/subagents — Async run summaries for the fleet panel
 *
 * Reads run dirs (status.json) into lightweight summaries. Ported essence of
 * pi-subagents async-status.ts listAsyncRuns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "./async-runner.js";

export interface AsyncRunSummary {
  runId: string;
  runDir: string;
  agent: string;
  state: string;
  startedAt: number;
  taskSummary?: string;
}

const MAX_CANDIDATES = 100;

/** States that keep a run in the live dock (vs. terminal). */
const ACTIVE_STATES = new Set(["running", "queued", "pending"]);

/**
 * An async run stops counting as active the moment its owning process is gone.
 * The ASYNC_DIR is a single global temp dir shared by every pi process on the
 * host, so a crashed/killed session leaves "running" status.json files behind
 * that would otherwise haunt the dock of every unrelated project forever.
 */
function ownerAlive(status: Record<string, unknown>): boolean {
  const pid = status.ownerPid;
  if (typeof pid !== "number" || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    // Signal 0 probes existence/permission without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → the process exists but is owned by someone else (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ListAsyncRunsOptions {
  /**
   * When set, only runs stamped with this session id are returned. Legacy runs
   * with no sessionId (created before session-scoping, or by another host
   * process) are excluded — they belong to no live dock.
   */
  sessionId?: string;
}

/** List async runs (any state), newest first. */
export function listAsyncRunSummaries(
  asyncDirRoot: string,
  options: ListAsyncRunsOptions = {},
): AsyncRunSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(asyncDirRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const summaries: AsyncRunSummary[] = [];
  for (const entry of entries.slice(0, MAX_CANDIDATES)) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(asyncDirRoot, entry.name);
    const status = readStatus(runDir);
    if (!status.status) continue;

    // Session scoping: a run belongs to exactly one session's dock.
    const runSession = typeof status.sessionId === "string" ? status.sessionId : undefined;
    if (options.sessionId !== undefined && runSession !== options.sessionId) continue;

    // Self-heal: an "active" run whose owner process is dead is a crash orphan.
    const state = String(status.status);
    if (ACTIVE_STATES.has(state) && !ownerAlive(status)) continue;

    summaries.push({
      runId: entry.name,
      runDir,
      agent: typeof status.agent === "string" ? status.agent : "unknown",
      state,
      startedAt:
        typeof status.startedAt === "number"
          ? status.startedAt
          : typeof status.updatedAt === "number"
            ? status.updatedAt
            : statMtime(runDir),
      ...(typeof status.task === "string" ? { taskSummary: status.task.slice(0, 120) } : {}),
    });
  }
  return summaries.sort((left, right) => right.startedAt - left.startedAt);
}

function statMtime(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return Date.now();
  }
}
