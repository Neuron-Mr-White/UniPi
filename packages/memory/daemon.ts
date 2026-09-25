/**
 * @unipi/memory — MemPalace daemon client
 *
 * All palace writes go through the daemon's /jobs queue — it holds the
 * lifetime writer lease, so it's the only safe write path when it runs.
 * `ensureDaemon` starts it when allowed; `submit`+`wait` drive jobs.
 */

import {
  DEFAULT_PALACE,
  daemonEndpoint,
  probeDaemon,
  runProcess,
  runProcessCombined,
  runProcessOutput,
  venvBin,
  type MempalaceInstall,
} from "./mempalace.js";
import { readMemoryConfig } from "./settings.js";
import { MemoryReader } from "./reader.js";

/** Oldest MemPalace this extension drives: daemon 3.5, read-only reader
 *  3.6, `mine` files payload 3.10. */
export const MIN_MEMPALACE = "3.10.0";

export interface DaemonJob {
  id: string;
  kind: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
  result?: Record<string, unknown>;
  error?: unknown;
}

export interface JobSubmitResult {
  ok: boolean;
  job?: DaemonJob;
  error?: string;
}

export interface JobWaitResult {
  /** The job reached a terminal state within the timeout. */
  done: boolean;
  job?: DaemonJob;
  error?: string;
}

async function daemonRequest(
  palacePath: string,
  method: "GET" | "POST",
  route: string,
  body?: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status?: number; body?: Record<string, unknown>; error?: string }> {
  const ep = daemonEndpoint(palacePath);
  if (!ep) return { ok: false, error: "no daemon endpoint" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const resp = await fetch(`http://${ep.host}:${ep.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${ep.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, status: resp.status, error: `non-JSON response (${resp.status}): ${text.slice(0, 200)}` };
    }
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        error: typeof parsed.error === "string" ? parsed.error : `HTTP ${resp.status}`,
      };
    }
    return { ok: true, status: resp.status, body: parsed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ensure the palace daemon is up. Returns true when healthy — either it was
 * already running or `mempalace daemon start` brought it up (autoStartDaemon
 * switch permitting). Times out after ~10s total.
 */
export async function ensureDaemon(
  palacePath = DEFAULT_PALACE,
  install?: MempalaceInstall | null,
  autoStart?: boolean,
): Promise<boolean> {
  if ((await probeDaemon(palacePath)).reachable) return true;

  const allowed = autoStart ?? readMemoryConfig().autoStartDaemon;
  if (!allowed || !install) return false;

  await runProcess(venvBin(install, "mempalace"), ["--palace", palacePath, "daemon", "start"], 15_000);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await probeDaemon(palacePath, 500)).reachable) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Submit a job; resolves with the queued job record or an error string. */
export async function submitJob(
  kind: string,
  payload: Record<string, unknown>,
  palacePath = DEFAULT_PALACE,
): Promise<JobSubmitResult> {
  const resp = await daemonRequest(palacePath, "POST", "/jobs", { kind, payload });
  if (!resp.ok) return { ok: false, error: resp.error ?? "submit failed" };
  const job = resp.body?.job as DaemonJob | undefined;
  if (!job?.id) return { ok: false, error: "submit returned no job" };
  return { ok: true, job };
}

/** Poll /jobs/<id> until terminal or timeoutMs. */
export async function waitJob(
  jobId: string,
  timeoutMs = 10_000,
  palacePath = DEFAULT_PALACE,
): Promise<JobWaitResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resp = await daemonRequest(palacePath, "GET", `/jobs/${jobId}`, undefined, 5_000);
    if (!resp.ok) return { done: false, error: resp.error ?? "job poll failed" };
    const job = resp.body?.job as DaemonJob | undefined;
    if (!job) return { done: false, error: "job vanished" };
    if (job.state !== "queued" && job.state !== "running" && job.state !== "deferred") {
      return { done: true, job };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { done: false, error: "timed out" };
}

export type WriteOutcome = "filed" | "queued" | "markdown-only";

export interface StoreOutcome {
  outcome: WriteOutcome;
  jobId?: string;
  error?: string;
}

/**
 * File a memory md through a daemon mine job. The daemon executes the write
 * it already owns the lock for — the only safe path while it runs.
 */
export async function fileThroughDaemon(
  install: MempalaceInstall,
  sourceDir: string,
  files: string[],
  wing: string,
  palacePath = DEFAULT_PALACE,
  waitMs = 10_000,
): Promise<StoreOutcome> {
  if (!(await ensureDaemon(palacePath, install))) {
    return { outcome: "markdown-only", error: "daemon unreachable" };
  }
  const submitted = await submitJob(
    "mine",
    { source: sourceDir, files, wing, agent: "unipi", palace_path: palacePath },
    palacePath,
  );
  if (!submitted.ok || !submitted.job) {
    return { outcome: "markdown-only", error: submitted.error ?? "job refused" };
  }
  const waited = await waitJob(submitted.job.id, waitMs, palacePath);
  if (!waited.done || !waited.job) {
    return { outcome: "queued", jobId: submitted.job.id, error: waited.error };
  }
  const result = waited.job.result ?? {};
  if (waited.job.state === "succeeded" && (result.success === undefined || result.success === true)) {
    return { outcome: "filed", jobId: submitted.job.id };
  }
  const err = typeof result.error === "string" ? result.error : waited.job.state;
  return { outcome: "markdown-only", jobId: submitted.job.id, error: `mine job ${waited.job.state}: ${err}` };
}

/** Delete a source's drawers through a daemon mcp_tool job. */
export async function deleteThroughDaemon(
  install: MempalaceInstall,
  sourceFile: string,
  palacePath = DEFAULT_PALACE,
  waitMs = 10_000,
): Promise<StoreOutcome> {
  if (!(await ensureDaemon(palacePath, install))) {
    return { outcome: "markdown-only", error: "daemon unreachable" };
  }
  const submitted = await submitJob(
    "mcp_tool",
    {
      name: "mempalace_delete_by_source",
      arguments: { source_file: sourceFile, dry_run: false },
    },
    palacePath,
  );
  if (!submitted.ok || !submitted.job) {
    return { outcome: "markdown-only", error: submitted.error ?? "job refused" };
  }
  const waited = await waitJob(submitted.job.id, waitMs, palacePath);
  if (!waited.done || !waited.job) {
    return { outcome: "queued", jobId: submitted.job.id, error: waited.error };
  }
  const result = waited.job.result ?? {};
  if (waited.job.state === "succeeded" && (result.success === undefined || result.success === true)) {
    return { outcome: "filed", jobId: submitted.job.id };
  }
  const err = typeof result.error === "string" ? result.error : waited.job.state;
  return { outcome: "markdown-only", jobId: submitted.job.id, error: `delete job ${waited.job.state}: ${err}` };
}

export interface DirectWriteResult {
  ok: boolean;
  /** The lock holder's text when the write failed on MineAlreadyRunning —
   *  e.g. "… is held by PID 1234 (/path/to/mempalace-mcp)". */
  heldBy?: string;
  error?: string;
}

/** Extract the "is held by …" tail of a lock error, if present. */
export function lockHolder(text: string): string | undefined {
  const m = text.match(/is held by ([^\n]+)/);
  return m ? m[1].trim() : undefined;
}

/**
 * The no-daemon store fallback: `mempalace mine` with NO --direct — the
 * user's write_routing config decides (prefer → direct write, require →
 * fails into the pending journal).
 */
export async function mineDirect(
  install: MempalaceInstall,
  sourceDir: string,
  wing: string,
  palacePath = DEFAULT_PALACE,
): Promise<DirectWriteResult> {
  const res = await runProcessCombined(
    venvBin(install, "mempalace"),
    ["--palace", palacePath, "mine", sourceDir, "--wing", wing, "--agent", "unipi"],
    120_000,
  );
  if (res.code === 0) return { ok: true };
  const text = `${res.stdout}\n${res.stderr}`;
  return { ok: false, heldBy: lockHolder(text), error: text.trim().split("\n").pop() };
}

/**
 * The no-daemon delete fallback: a one-shot WRITE-mode MCP server — it takes
 * the palace lease briefly, calls mempalace_delete_by_source, exits. When the
 * lease is already held the server fails to start; the holder text goes into
 * the pending entry.
 */
export async function deleteViaWriteMcp(
  install: MempalaceInstall,
  sourceFile: string,
  palacePath = DEFAULT_PALACE,
): Promise<DirectWriteResult> {
  const proc = new MemoryReader(install, palacePath, false);
  const up = await proc.start();
  if (!up) {
    proc.kill();
    return { ok: false, error: "write-mode MCP server failed to start" };
  }
  try {
    const res = (await proc.callWriteTool("mempalace_delete_by_source", {
      source_file: sourceFile,
      dry_run: false,
    })) as { deleted?: number; success?: boolean; error?: string } | { error: string } | null;
    if (!res || (typeof res === "object" && "error" in res)) {
      return { ok: false, error: String((res as { error?: string })?.error ?? "delete failed") };
    }
    if ((res as { success?: boolean }).success === false) {
      return { ok: false, error: String((res as { error?: string }).error ?? "delete failed") };
    }
    return { ok: true };
  } finally {
    proc.kill();
  }
}

/** `mempalace wake-up --wing <w>` for the start reminder. */
export async function wakeUp(
  install: MempalaceInstall,
  wing: string,
  palacePath = DEFAULT_PALACE,
  timeoutMs = 15_000,
): Promise<string | null> {
  const scoped = await runProcessOutput(
    venvBin(install, "mempalace"),
    ["--palace", palacePath, "wake-up", "--wing", wing],
    timeoutMs,
  );
  if (scoped?.trim()) return scoped.trim();
  return runProcessOutput(
    venvBin(install, "mempalace"),
    ["--palace", palacePath, "wake-up"],
    timeoutMs,
  );
}
