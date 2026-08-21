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

/** List async runs (any state), newest first. */
export function listAsyncRunSummaries(asyncDirRoot: string): AsyncRunSummary[] {
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
    summaries.push({
      runId: entry.name,
      runDir,
      agent: typeof status.agent === "string" ? status.agent : "unknown",
      state: String(status.status),
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
