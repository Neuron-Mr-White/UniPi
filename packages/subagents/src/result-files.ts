/**
 * @pi-unipi/subagents — Durable async result files + indexes
 *
 * Ported from pi-subagents src/runs/background/result-files.ts (core).
 * Results land under OUR RESULTS_DIR (temp root /async-subagent-results):
 *   <runId>.json                — the result payload
 *   result-index/runs/<runId>   — run-id index entry
 *   result-index/sessions/<sid> — session index entries
 *   result-pending/<sid>/<rid>  — pending delivery markers
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { RESULTS_DIR } from "./parity-types.js";

export const RESULT_INDEX_VERSION = 1;
const RESULT_INDEX_DIR = "result-index";
const SESSION_INDEX_DIR = "sessions";
const RUN_INDEX_DIR = "runs";
const RESULT_PENDING_DIR = "result-pending";

export interface ResultIndexEntry {
  version: 1;
  runId: string;
  sessionId: string;
  file: string;
  writtenAt: number;
  asyncDir?: string;
}

export interface ResultFileData {
  version: 1;
  runId: string;
  sessionId: string;
  agent?: string;
  output?: string;
  structuredOutput?: unknown;
  error?: string;
  success?: boolean;
  state?: string;
  timedOut?: boolean;
  stopped?: boolean;
  processSignal?: string | null;
  durationMs?: number;
  writtenAt: number;
}

/** Encode an index segment safely (reference index-segment core). */
function encodeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

export function resultFilePath(resultsDir: string, runId: string): string {
  return path.join(resultsDir, `${runId}.json`);
}

function sessionIndexDir(resultsDir: string, sessionId: string): string {
  return path.join(resultsDir, RESULT_INDEX_DIR, SESSION_INDEX_DIR, encodeSegment(sessionId));
}

function resultIndexPath(resultsDir: string, sessionId: string, runId: string): string {
  return path.join(sessionIndexDir(resultsDir, sessionId), `${runId}.json`);
}

function runIndexPath(resultsDir: string, runId: string): string {
  return path.join(resultsDir, RESULT_INDEX_DIR, RUN_INDEX_DIR, `${runId}.json`);
}

function resultPendingPath(resultsDir: string, sessionId: string, runId: string): string {
  return path.join(resultsDir, RESULT_PENDING_DIR, encodeSegment(sessionId), `${runId}.json`);
}

function writeAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function parseResultIndexEntry(value: unknown): ResultIndexEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Partial<ResultIndexEntry>;
  if (
    record.version !== RESULT_INDEX_VERSION ||
    typeof record.runId !== "string" ||
    !record.runId ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    typeof record.file !== "string" ||
    !record.file ||
    typeof record.writtenAt !== "number"
  ) {
    return undefined;
  }
  return record as ResultIndexEntry;
}

/** Write the durable result payload + run/session indexes + pending marker. */
export function writeAsyncResultFile(
  resultsDir: string,
  data: Omit<ResultFileData, "version" | "writtenAt">,
  options: { asyncDir?: string } = {},
): ResultFileData {
  const payload: ResultFileData = { ...data, version: 1, writtenAt: Date.now() };
  const file = resultFilePath(resultsDir, payload.runId);
  writeAtomicJson(file, payload);

  const entry: ResultIndexEntry = {
    version: RESULT_INDEX_VERSION,
    runId: payload.runId,
    sessionId: payload.sessionId,
    file,
    writtenAt: payload.writtenAt,
    ...(options.asyncDir ? { asyncDir: options.asyncDir } : {}),
  };
  writeAtomicJson(runIndexPath(resultsDir, payload.runId), entry);
  writeAtomicJson(resultIndexPath(resultsDir, payload.sessionId, payload.runId), entry);
  writeAtomicJson(resultPendingPath(resultsDir, payload.sessionId, payload.runId), entry);
  return payload;
}

/** Read a result payload by run id (via the run index). */
export function readAsyncResultFile(resultsDir: string, runId: string): ResultFileData | undefined {
  const entry = readResultIndexEntry(runIndexPath(resultsDir, runId));
  if (!entry) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(entry.file, "utf8")) as ResultFileData;
    if (parsed?.version !== 1 || typeof parsed.runId !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readResultIndexEntry(indexPath: string): ResultIndexEntry | undefined {
  try {
    return parseResultIndexEntry(JSON.parse(fs.readFileSync(indexPath, "utf8")));
  } catch {
    return undefined;
  }
}

/** List result index entries for a session. */
export function resultCandidateFilesForSession(
  resultsDir: string,
  sessionId: string,
): string[] {
  const dir = sessionIndexDir(resultsDir, sessionId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Remove a pending delivery marker (after delivery or dismissal). */
export function removePendingResult(resultsDir: string, sessionId: string, runId: string): void {
  try {
    fs.unlinkSync(resultPendingPath(resultsDir, sessionId, runId));
  } catch {
    // Already gone.
  }
}

/** Remove the result payload + all indexes for a run. */
export function removeResultIndex(resultsDir: string, sessionId: string, runId: string): void {
  removePendingResult(resultsDir, sessionId, runId);
  for (const target of [
    runIndexPath(resultsDir, runId),
    resultIndexPath(resultsDir, sessionId, runId),
    resultFilePath(resultsDir, runId),
  ]) {
    try {
      fs.unlinkSync(target);
    } catch {
      // Already gone.
    }
  }
}

/** Prune result indexes older than maxAgeMs (default 24h). Returns removed count. */
export function cleanupResultIndexes(resultsDir: string, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): number {
  let removed = 0;
  const indexRoot = path.join(resultsDir, RESULT_INDEX_DIR);
  let walk: string[];
  try {
    walk = [indexRoot];
  } catch {
    return 0;
  }
  while (walk.length > 0) {
    const dir = walk.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      try {
        const stat = fs.statSync(entryPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(entryPath);
          removed++;
        }
      } catch {
        // raced away
      }
    }
  }
  return removed;
}

/** Our default results dir. */
export function defaultResultsDir(): string {
  return RESULTS_DIR;
}
