/**
 * @pi-unipi/subagents — Async child process runner (Phase 3 core)
 *
 * Ported from pi-subagents src/runs/background/subagent-runner.ts (the
 * runPiStreaming core). Spawns a child `pi --mode json -p` process, streams
 * JSON events from stdout, collects the final assistant message + usage,
 * enforces the run deadline, propagates abort/stop, and escalates to file
 * task delivery after an unexplained zero-activity SIGKILL (EDR workaround).
 *
 * Artifacts land under OUR temp root: async-subagent-runs/<runId>/
 * (status.json, output.txt, events.jsonl).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getPiSpawnCommand } from "./pi-spawn.js";
import { buildPiArgs, cleanupTempDir, type SubagentTaskDelivery } from "./pi-args.js";
import { ASYNC_DIR, ensureDirs } from "./parity-types.js";
import { childDepthEnv, resolveMaxSubagentDepth } from "./child-safety.js";
import type { AgentConfig, SubagentsConfig } from "./types.js";

// ============================================================================
// Types
// ============================================================================

/** JSON event lines the child pi emits in --mode json. */
export interface ChildEvent {
  type: string;
  [key: string]: unknown;
}

export interface AsyncRunSpec {
  agent: AgentConfig;
  task: string;
  cwd: string;
  /** Extra pi CLI args (e.g. model/tool flags handled by the caller). */
  baseArgs?: string[];
  model?: string;
  thinking?: string | false;
  tools?: string[];
  extensions?: string[];
  systemPrompt?: string;
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  sessionDir?: string;
  timeoutMs?: number;
  taskDelivery?: SubagentTaskDelivery;
  parentSessionId?: string;
  config?: SubagentsConfig;
  /** Pre-resolved fork session file (context: "fork"). When present the child
   *  launches with --session <file>, branching from the parent conversation. */
  forkSessionFile?: string;
  /** Force thinking off for this child (sanitized Anthropic fork). */
  forceThinkingOff?: boolean;
  /** Observation callbacks */
  onEvent?: (event: ChildEvent) => void;
  onOutputLine?: (line: string) => void;
}

export type AsyncRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "timedOut";

export interface AsyncRunResult {
  runId: string;
  status: AsyncRunStatus;
  output: string;
  error?: string;
  /** Process-terminal proof: the child pid and observed exit. */
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Usage parsed from the child's final event (best effort). */
  usage?: { input?: number; output?: number; total?: number };
  durationMs: number;
  /** True when the run was retried with file task delivery after zero-activity SIGKILL. */
  retriedFileDelivery?: boolean;
}

// ============================================================================
// Runner
// ============================================================================

const ZERO_ACTIVITY_TIMEOUT_MS = 20_000;

/** Format the effective child system prompt (agent prompt + boundary + memory). */
function effectiveChildPrompt(spec: AsyncRunSpec): string {
  return spec.systemPrompt ?? spec.agent.systemPrompt;
}

/** Run one child pi process to completion. */
async function runChildProcess(
  spec: AsyncRunSpec,
  runDir: string,
  signal: AbortSignal,
  forceFileDelivery: boolean,
): Promise<AsyncRunResult> {
  const startedAt = Date.now();
  const runId = path.basename(runDir);
  const outputFile = path.join(runDir, "output.txt");

  const { args, env: childEnv, tempDir } = buildPiArgs({
    baseArgs: spec.baseArgs ?? ["--mode", "json", "-p"],
    task: spec.task,
    sessionFile: spec.forkSessionFile,
    sessionDir: spec.sessionDir,
    model: spec.model,
    thinking: spec.forceThinkingOff ? "off" : spec.thinking,
    tools: spec.tools,
    extensions: spec.extensions,
    systemPrompt: effectiveChildPrompt(spec),
    systemPromptMode: spec.systemPromptMode ?? spec.agent.promptMode,
    promptFileStem: spec.agent.name,
    inheritProjectContext: spec.inheritProjectContext ?? spec.agent.inheritProjectContext,
    inheritSkills: spec.inheritSkills ?? spec.agent.inheritSkills,
    taskDelivery: forceFileDelivery ? "file" : spec.taskDelivery,
    parentSessionId: spec.parentSessionId,
    childAgentName: spec.agent.name,
    runId,
  });

  const maxDepth = resolveMaxSubagentDepth(spec.agent, spec.config);
  const depthEnv = childDepthEnv(process.env, maxDepth);
  const spawnEnv = { ...process.env, ...childEnv, ...depthEnv };

  const spawnSpec = getPiSpawnCommand(args, { env: spawnEnv });

  return await new Promise<AsyncRunResult>((resolve) => {
    const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
    const child: ChildProcess = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let output = "";
    let usage: AsyncRunResult["usage"];
    let error: string | undefined;
    let timedOut = false;
    let stopped = false;
    let zeroActivityTimer: ReturnType<typeof setTimeout> | undefined;
    let sawActivity = false;
    let settled = false;

    const finish = (result: Omit<AsyncRunResult, "runId" | "durationMs">) => {
      if (settled) return;
      settled = true;
      if (zeroActivityTimer) clearTimeout(zeroActivityTimer);
      signal.removeEventListener("abort", onAbort);
      outputStream.end();
      cleanupTempDir(tempDir);
      resolve({ ...result, runId, durationMs: Date.now() - startedAt });
    };

    const onAbort = () => {
      stopped = true;
      trySignalChild(child, "SIGTERM");
      // Grace period then hard kill.
      setTimeout(() => trySignalChild(child, "SIGKILL"), 3_000);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Run deadline.
    const deadlineMs = spec.timeoutMs;
    if (deadlineMs !== undefined && Number.isInteger(deadlineMs) && deadlineMs > 0) {
      setTimeout(() => {
        timedOut = true;
        trySignalChild(child, "SIGTERM");
        setTimeout(() => trySignalChild(child, "SIGKILL"), 3_000);
      }, deadlineMs).unref?.();
    }

    // Zero-activity watchdog: escalate a silent child.
    zeroActivityTimer = setTimeout(() => {
      if (!sawActivity && !settled) {
        trySignalChild(child, "SIGKILL");
      }
    }, ZERO_ACTIVITY_TIMEOUT_MS);

    child.on("error", (err) => {
      error = `Failed to launch child pi process: ${err.message}`;
      finish({ status: "failed", output: "", error });
    });

    if (typeof child.pid === "number") {
      // Record ownership for the process-terminal proof.
      try {
        fs.writeFileSync(path.join(runDir, "process.json"), JSON.stringify({ pid: child.pid, startedAt }), { mode: 0o600 });
      } catch { /* best effort */ }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      sawActivity = true;
      const text = chunk.toString("utf8");
      outputStream.write(text);
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        spec.onOutputLine?.(line);
        let event: ChildEvent;
        try {
          event = JSON.parse(line) as ChildEvent;
        } catch {
          continue;
        }
        spec.onEvent?.(event);
        // Track the final assistant message + usage from agent_end-style events.
        if (event.type === "message_end" || event.type === "agent_end" || event.type === "agent_settled") {
          const assistantText = extractAssistantText(event);
          if (assistantText !== undefined) output = assistantText;
          const eventUsage = extractUsage(event);
          if (eventUsage) usage = eventUsage;
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      sawActivity = true;
      const text = chunk.toString("utf8");
      outputStream.write(text);
      if (!error && /Error|FATAL/i.test(text)) {
        error = text.trim().split("\n").slice(-3).join("\n").slice(0, 500);
      }
    });

    child.on("close", (code, signalName) => {
      if (stopped) {
        finish({ status: "stopped", output, pid: child.pid, exitCode: code, signal: signalName });
        return;
      }
      if (timedOut) {
        finish({
          status: "timedOut",
          output,
          error: `Run timed out after ${spec.timeoutMs}ms.`,
          pid: child.pid,
          exitCode: code,
          signal: signalName,
        });
        return;
      }
      // Zero-activity SIGKILL: retry once with file delivery (EDR workaround).
      if (code === null && signalName === "SIGKILL" && !sawActivity) {
        finish({
          status: "failed",
          output,
          error: "Child process was killed before any output (possible EDR/AV interference).",
          pid: child.pid,
          exitCode: code,
          signal: signalName,
          retriedFileDelivery: true,
        });
        return;
      }
      const ok = code === 0;
      finish({
        status: ok ? "completed" : "failed",
        output: output || (ok ? "" : `Child exited with code ${code}.`),
        ...(error && !ok ? { error } : {}),
        pid: child.pid,
        exitCode: code,
        signal: signalName,
        ...(usage ? { usage } : {}),
      });
    });
  });
}

function trySignalChild(child: ChildProcess, signalName: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) {
      // Negative pid targets the detached process group (kills grandchildren shells too).
      process.kill(-child.pid, signalName);
    }
  } catch {
    try {
      child.kill(signalName);
    } catch {
      // Already dead.
    }
  }
}

function extractAssistantText(event: ChildEvent): string | undefined {
  const message = (event as { message?: { role?: string; content?: unknown } }).message;
  if (!message || message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
      .map((p) => p.text)
      .join("");
  }
  return undefined;
}

function extractUsage(event: ChildEvent): AsyncRunResult["usage"] | undefined {
  const usage = (event as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const input = num(usage.input) ?? num(usage.inputTokens);
  const output = num(usage.output) ?? num(usage.outputTokens);
  const total = num(usage.total) ?? num(usage.totalTokens);
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { input, output, total };
}

// ============================================================================
// Public API — run with artifacts + status lifecycle
// ============================================================================

/** Create the run directory + initial status.json. */
export function createAsyncRunDir(agentName: string): string {
  ensureDirs();
  const runId = `${agentName.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const runDir = path.join(ASYNC_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  writeStatus(runDir, { status: "queued", agent: agentName, createdAt: Date.now() });
  return runDir;
}

export function writeStatus(runDir: string, status: Record<string, unknown>): void {
  try {
    const existing = readStatus(runDir);
    fs.writeFileSync(
      path.join(runDir, "status.json"),
      `${JSON.stringify({ ...existing, ...status, updatedAt: Date.now() })}\n`,
      { mode: 0o600 },
    );
  } catch {
    fs.writeFileSync(
      path.join(runDir, "status.json"),
      `${JSON.stringify({ ...status, updatedAt: Date.now() })}\n`,
      { mode: 0o600 },
    );
  }
}

export function readStatus(runDir: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Launch an async run. Writes status.json transitions (queued → running →
 * terminal), streams events, and returns the terminal result. Zero-activity
 * SIGKILL retries once with forced file task delivery.
 */
export async function runAsyncSubagent(
  spec: AsyncRunSpec,
  runDir: string,
  signal: AbortSignal,
): Promise<AsyncRunResult> {
  writeStatus(runDir, { status: "running", pid: "pending" });

  let result = await runChildProcess(spec, runDir, signal, false);

  // EDR workaround: retry once with file delivery.
  if (result.status === "failed" && result.retriedFileDelivery) {
    writeStatus(runDir, { status: "running", retry: "file-delivery" });
    result = await runChildProcess(spec, runDir, signal, true);
    result.retriedFileDelivery = true;
  }

  writeStatus(runDir, {
    status: result.status,
    error: result.error,
    exitCode: result.exitCode ?? null,
    durationMs: result.durationMs,
  });
  return result;
}
