/**
 * @pi-unipi/subagents — Async result watcher
 *
 * Ported from pi-subagents src/runs/background/result-watcher.ts (core).
 * Watches OUR results dir for pending delivery markers, parses payloads,
 * delivers completion notifications to the owning session, and logs slow
 * scans per the resultScanLogging config ("all" | "activity" | "off").
 * Periodic healthy rescans keep cross-session deliveries working.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  readAsyncResultFile,
  removePendingResult,
  removeResultIndex,
  resultCandidateFilesForSession,
  type ResultFileData,
} from "./result-files.js";

const POLL_INTERVAL_MS = 3000;
const HEALTHY_SCAN_INTERVAL_MS = 60_000;
const SLOW_RESULT_SCAN_MS = 500;

export interface CompletionNotification {
  runId: string;
  agent?: string;
  output?: string;
  error?: string;
  success: boolean;
  state?: string;
  timedOut?: boolean;
  durationMs?: number;
}

export interface ResultWatcherDeps {
  resultsDir: string;
  sessionId: string;
  /** Deliver a completion (e.g. pi.sendMessage notification). */
  notifier: (notification: CompletionNotification) => void;
  /** Logging mode for slow scans. Default "all". */
  resultScanLogging?: "all" | "activity" | "off";
  /** Test seams. */
  intervalMs?: number;
  healthyScanIntervalMs?: number;
  log?: (message: string) => void;
}

export interface ResultWatcher {
  /** Force a scan now. */
  scan(): Promise<void>;
  stop(): void;
}

/**
 * Create the watcher. Scans the session's pending result markers; for each
 * found payload, delivers the completion and removes the marker. The full
 * result payload + indexes are retained for later reads (get_helper_result,
 * children.list) until retention cleanup.
 */
export function createResultWatcher(deps: ResultWatcherDeps): ResultWatcher {
  const log = deps.log ?? ((message: string) => console.error(message));
  const scanLogging = deps.resultScanLogging ?? "all";
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let healthyTimer: ReturnType<typeof setInterval> | undefined;
  let scanning = false;

  async function scanOnce(): Promise<void> {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const startedAt = Date.now();
      const pendingFiles = listPendingFiles(deps.resultsDir, deps.sessionId);
      const scanDuration = Date.now() - startedAt;
      const slow = scanDuration > SLOW_RESULT_SCAN_MS;
      const foundWork = pendingFiles.length > 0;

      if (slow && scanLogging !== "off" && (scanLogging === "all" || foundWork)) {
        log(
          `Subagent result scan inspected ${pendingFiles.length} pending marker(s) in ${scanDuration}ms`,
        );
      }

      for (const pendingFile of pendingFiles) {
        const runId = path.basename(pendingFile).replace(/\.json$/, "");
        const payload = readAsyncResultFile(deps.resultsDir, runId);
        if (!payload) {
          // Unreadable/corrupt marker — drop it so it never loops.
          try {
            fs.unlinkSync(pendingFile);
          } catch { /* gone */ }
          continue;
        }
        deps.notifier({
          runId: payload.runId,
          ...(payload.agent ? { agent: payload.agent } : {}),
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          ...(payload.error ? { error: payload.error } : {}),
          success: payload.success ?? payload.state === "completed",
          state: payload.state,
          timedOut: payload.timedOut,
          durationMs: payload.durationMs,
        });
        removePendingResult(deps.resultsDir, deps.sessionId, runId);
      }
    } finally {
      scanning = false;
    }
  }

  // Pending markers for this session live under result-pending/<session>/.
  function listPendingFiles(resultsDir: string, sessionId: string): string[] {
    const dir = path.join(resultsDir, "result-pending", sessionId);
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

  function start(): void {
    const interval = deps.intervalMs ?? POLL_INTERVAL_MS;
    timer = setInterval(() => {
      void scanOnce();
    }, interval);
    timer.unref?.();
    const healthyInterval = deps.healthyScanIntervalMs ?? HEALTHY_SCAN_INTERVAL_MS;
    healthyTimer = setInterval(() => {
      void scanOnce();
    }, healthyInterval);
    healthyTimer.unref?.();
  }

  start();
  void scanOnce();

  return {
    scan: scanOnce,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      if (healthyTimer) clearInterval(healthyTimer);
    },
  };
}

/**
 * Retention cleanup (ported essence of async-retention.ts): remove terminal
 * async run dirs + result payloads older than maxAgeMs. Only terminal runs
 * are eligible; a missing status.json is treated as terminal after the age
 * window (orphan cleanup).
 */
export function cleanupAsyncRetention(
  asyncDir: string,
  resultsDir: string,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000,
): { runsRemoved: number; resultsRemoved: number } {
  let runsRemoved = 0;
  let resultsRemoved = 0;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(asyncDir, { withFileTypes: true });
  } catch {
    return { runsRemoved, resultsRemoved };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(asyncDir, entry.name);
    try {
      const stat = fs.statSync(runDir);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      const statusFile = path.join(runDir, "status.json");
      let terminal = true;
      if (fs.existsSync(statusFile)) {
        try {
          const status = JSON.parse(fs.readFileSync(statusFile, "utf8")) as { status?: string };
          terminal = !["queued", "running"].includes(String(status.status));
        } catch {
          terminal = true; // unreadable = treat as terminal after age window
        }
      }
      if (!terminal) continue;
      fs.rmSync(runDir, { recursive: true, force: true });
      runsRemoved++;
      // Remove the associated result payload + indexes if present.
      try {
        const payload = readAsyncResultFile(resultsDir, entry.name);
        if (payload) {
          removeResultIndex(resultsDir, payload.sessionId, entry.name);
          resultsRemoved++;
        }
      } catch {
        // best effort
      }
    } catch {
      // raced away
    }
  }

  return { runsRemoved, resultsRemoved };
}
