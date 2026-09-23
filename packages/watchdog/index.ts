/**
 * @pi-unipi/watchdog — Jev watchdog for long-running tool calls and
 * background tasks.
 *
 * Off by default. When enabled, every interval each watched item (pi's bash
 * tool calls, background tasks) is judged by jev (the long-horizon Decision
 * model): is it progressing, legitimately waiting, stuck, or looping? Only
 * stuck/looping answers with enough confidence, for enough consecutive
 * checks, on a non-persistent process, trigger a kill (or warn). pi's bash
 * tool is NOT overridden — the watchdog kills the tool's detached process
 * group out-of-band and annotates the tool result.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev, readJudgeJevSettings } from "@pi-unipi/core";
import { getSharedTaskRegistry } from "@pi-unipi/background-tasks";
import { loadWatchdogSettings, registerWatchdogSettings, type WatchdogSettings } from "./src/config.js";
import { evaluateTick } from "./src/decide.js";
import { findBashChildren, killProcessGroup } from "./src/bash-kill.js";

const VERSION = "0.1.0";

/** Tools that are inherently quick or human-interactive — never watched. */
const NEVER_WATCH = new Set([
  "read", "write", "edit", "grep", "find", "ls",
  "ask_user",
  "bg_result", "bg_kill", "bg_tasks",
  "set_session_name", "ctx_env",
]);

interface TrackedCall {
  toolCallId: string;
  toolName: string;
  /** bash: the command string; others: summarized args. */
  display: string;
  startedAt: number;
  lastChangeAt: number;
  lastTail: string;
}

interface KillRecord {
  toolCallId: string;
  durationMs: number;
  reason: string;
}

const state = {
  pi: null as ExtensionAPI | null,
  ctx: null as ExtensionContext | null,
  firstTimer: null as NodeJS.Timeout | null,
  intervalTimer: null as NodeJS.Timeout | null,
  bash: new Map<string, TrackedCall>(),
  other: new Map<string, TrackedCall>(),
  streaks: new Map<string, number>(),
  kills: new Map<string, KillRecord>(),
  pending: [] as string[],
  busy: false,
};

function debugLog(line: string): void {
  if (process.env.UNIPI_DEBUG_WATCHDOG !== "1") return;
  try {
    const dir = `${os.homedir()}/.unipi/logs`;
    mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/watchdog.log`, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort
  }
}

/** Test hook: run one watchdog tick against the current state. */
export async function __watchdogTick(ctx: ExtensionContext): Promise<void> {
  state.ctx = ctx;
  await tick(true);
}

/** Test hook: pretend the watchdog killed this bash call (drives the rewrite). */
export function __recordKill(toolCallId: string, record: { durationMs: number; reason: string }): void {
  state.kills.set(toolCallId, { toolCallId, ...record });
}

export function __getKills(): Map<string, unknown> {
  return state.kills;
}

/** Test hook: override the bg task list the scanner reads. */
export function setRegistryTasks(tasks: OverrideTask[]): void {
  registryOverride = tasks;
}

interface OverrideTask {
  id: string;
  command: string;
  status: string;
  startTime: number;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  outputTail?: string[];
  delegate?: unknown;
}
let registryOverride: OverrideTask[] | null = null;

/** Test hook: clear all watchdog state. */
export function resetWatchdogState(): void {
  stopTimer();
  state.bash.clear();
  state.other.clear();
  state.streaks.clear();
  state.kills.clear();
  state.pending = [];
  tailMemory.clear();
  registryOverride = null;
}

/** Register the watchdog with pi. */
export default function (pi: ExtensionAPI): void {
  registerWatchdogExtension(pi);
}

/** Extension wiring, separable for tests. */
/** Minimal event-registrar (real ExtensionAPI or a test fake). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWatchdogExtension(pi: any): void {
  try { const { appendFileSync, mkdirSync } = require("node:fs"); const { join } = require("node:path"); const d = join(require("node:os").homedir(), ".unipi", "logs"); mkdirSync(d, {recursive:true}); appendFileSync(join(d, "watchdog.log"), new Date().toISOString() + " registerWatchdogExtension called\n"); } catch {}
  state.pi = pi;
  registerWatchdogSettings(process.cwd());
  pi.on("__watchdog_tick", () => __watchdogTick(state.ctx as ExtensionContext));

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    try { const { appendFileSync } = require("node:fs"); appendFileSync(require("node:path").join(require("node:os").homedir(), ".unipi", "logs", "watchdog.log"), new Date().toISOString() + " session_start enabled=" + loadWatchdogSettings(ctx.cwd).enabled + "\n"); } catch {}
    state.ctx = ctx;
    const settings = loadWatchdogSettings(ctx.cwd);
    if (settings.enabled) startTimer(settings);
    else stopTimer();
  });

  pi.on("session_shutdown", () => {
    stopTimer();
    state.bash.clear();
    state.other.clear();
    state.streaks.clear();
    state.kills.clear();
    state.pending = [];
    state.ctx = null;
  });

  pi.on("tool_execution_start", (event: { toolCallId: string; toolName: string; args: unknown }) => {
    if (NEVER_WATCH.has(event.toolName)) return;
    const display = summarizeArgs(event.args);
    const now = Date.now();
    const tracked: TrackedCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      display,
      startedAt: now,
      lastChangeAt: now,
      lastTail: "",
    };
    if (event.toolName === "bash") state.bash.set(event.toolCallId, tracked);
    else state.other.set(event.toolCallId, tracked);
  });

  pi.on("tool_execution_update", (event: { toolCallId: string; partialResult: unknown }) => {
    const tracked = state.bash.get(event.toolCallId) ?? state.other.get(event.toolCallId);
    if (!tracked) return;
    const tail = String(event.partialResult ?? "");
    if (tail && tail !== tracked.lastTail) {
      tracked.lastChangeAt = Date.now();
      tracked.lastTail = tail.slice(-3200);
    }
  });

  pi.on("tool_execution_end", (event: { toolCallId: string }) => {
    state.bash.delete(event.toolCallId);
    state.other.delete(event.toolCallId);
    state.streaks.delete(event.toolCallId);
  });

  // Annotate the tool result of a watchdog-killed bash call.
  pi.on("tool_result", (event: { toolCallId: string; content: Array<{ type: string; text: string }> }) => {
    console.error("[WD tool_result] id:", event.toolCallId, "kills size:", state.kills.size, "has:", state.kills.has(event.toolCallId));
    const kill = state.kills.get(event.toolCallId);
    if (!kill) return undefined;
    state.kills.delete(event.toolCallId);
    const original = event.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const warning =
      `⚠ Killed by unipi watchdog after ${Math.round(kill.durationMs / 1000)}s: ` +
      `jev judged it ${kill.reason}. ` +
      `Do not blindly re-run; investigate or change approach.`;
    return {
      content: [{ type: "text", text: `${warning}\n\n${original}` }],
      isError: true,
    };
  });

  // Deliver warn/other-tool notifications to the agent on the next turn.
  pi.on("before_agent_start", async (event: { prompt: string; systemPrompt: string; systemPromptOptions?: { skills?: unknown[] } }) => {
    if (state.pending.length === 0) return undefined;
    const content = state.pending.join("\n\n");
    state.pending = [];
    return {
      message: {
        customType: "unipi-watchdog",
        content,
        display: true,
      },
    };
  });
}

function startTimer(settings: WatchdogSettings): void {
  stopTimer();
  state.firstTimer = setTimeout(() => {
    void tick(settings.enabled);
    state.intervalTimer = setInterval(() => void tick(settings.enabled), settings.intervalMin * 60_000);
  }, settings.firstCheckMin * 60_000);
  state.firstTimer.unref?.();
}

function stopTimer(): void {
  if (state.firstTimer) clearTimeout(state.firstTimer);
  if (state.intervalTimer) clearInterval(state.intervalTimer);
  state.firstTimer = null;
  state.intervalTimer = null;
}

interface WatchedItem {
  key: string;
  kind: "bash" | "bg" | "other";
  toolName: string;
  command: string;
  startedAt: number;
  sinceLastOutputSec: number;
  outputChanged: boolean;
  tail: string;
  /** bg registry task handle (kill path) */
  task?: { id: string; persistent: boolean };
}

function gatherWatched(settings: WatchdogSettings): WatchedItem[] {
  const now = Date.now();
  const items: WatchedItem[] = [];

  if (settings.watchBash) {
    for (const tracked of state.bash.values()) {
      items.push({
        key: `bash:${tracked.toolCallId}`,
        kind: "bash",
        toolName: "bash",
        command: tracked.display.slice(0, 500),
        startedAt: tracked.startedAt,
        sinceLastOutputSec: Math.round((now - tracked.lastChangeAt) / 1000),
        outputChanged: false, // filled per-tick by the caller-side comparison
        tail: tracked.lastTail.slice(-3000),
      });
    }
  }

  if (settings.watchBgTasks) {
    const tasks = registryOverride ?? getSharedTaskRegistry()?.allTasks() ?? [];
    for (const task of tasks) {
      if (task.status !== "running") continue;
      // Declared-persistent items (servers/watchers) are never checked.
      if (!task.triggerOnCompletion && !task.notifyOnCompletion) continue;
      const tail = (task.outputTail ?? []).join("\n");
      items.push({
        key: `bg:${task.id}`,
        kind: "bg",
        toolName: task.delegate ? "bg_delegate" : "bg_run",
        command: task.command.slice(0, 500),
        startedAt: task.startTime,
        sinceLastOutputSec: 0, // computed by the caller against the previous tail
        outputChanged: false,
        tail: tail.slice(-3000),
        task: {
          id: task.id,
          persistent: !task.triggerOnCompletion && !task.notifyOnCompletion,
        },
      });
    }
  }

  if (settings.otherTools !== "off") {
    for (const tracked of state.other.values()) {
      items.push({
        key: `other:${tracked.toolCallId}`,
        kind: "other",
        toolName: tracked.toolName,
        command: tracked.display.slice(0, 500),
        startedAt: tracked.startedAt,
        sinceLastOutputSec: Math.round((now - tracked.lastChangeAt) / 1000),
        outputChanged: false,
        tail: tracked.lastTail.slice(-3000),
      });
    }
  }
  return items;
}

async function tick(enabled: boolean): Promise<void> {
  if (state.busy) return;
  const ctx = state.ctx;
  if (!ctx) return;
  const settings = loadWatchdogSettings(ctx.cwd);
  if (!settings.enabled || !enabled) {
    stopTimer();
    return;
  }
  state.busy = true;
  try {
    const items = gatherWatched(settings);

    if (items.length > 0) ctx.ui.setStatus("watchdog", `watchdog: ${items.length}`);
    else ctx.ui.setStatus("watchdog", undefined);

    const jevSettings = readJudgeJevSettings(ctx.cwd);
    const seen = new Map<string, string>(); // key → tail at this tick
    for (const item of items) {
      const previous = state.streaks.get(item.key) ?? 0;
      const state_text =
        `Tool: ${item.toolName}\n` +
        `Command/args: ${item.command}\n` +
        `Running for: ${Math.round((Date.now() - item.startedAt) / 1000)}s\n` +
        `Since last new output: ${item.sinceLastOutputSec}s\n` +
        `Output changed since previous check: ${item.outputChanged ? "yes" : "no"}\n` +
        `Last output (tail):\n${item.tail || "(no output yet)"}`;
      const questions = {
        status: {
          type: "choice",
          instructions: "Is this long-running tool call progressing?",
          criteria: {
            progressing: "Making forward progress or doing expected long work",
            waiting: "Legitimately waiting (network, build step, sleep, human-scale timer)",
            stuck: "Hung, deadlocked, waiting on input that will never come, or frozen",
            looping: "Repeating the same failure/output without progress",
          },
        },
        persistent: {
          type: "noul",
          instructions:
            "Is this a long-lived process meant to run indefinitely (dev server, watcher, daemon, tail -f)?",
        },
      };
      const answers = await askJev({
        state: state_text,
        questions,
        settings: readJudgeJevSettings(ctx.cwd),
        fetchImpl: undefined,
        env: process.env,
      });
      const decision = evaluateTick(answers, previous, { confidence: settings.confidence });
      seen.set(item.key, item.tail);
      debugLog(
        `tick ${item.key}: status=${decision.status} confidence=${decision.confidence.toFixed(2)} ` +
        `streak=${decision.streak} persistent=${decision.persistent}`,
      );

      if (!decision.act) continue;

      const durationMs = Date.now() - item.startedAt;
      const reason =
        `${decision.status} (confidence ${decision.confidence.toFixed(2)}) ` +
        `on ${decision.streak} consecutive checks — ` +
        `${item.outputChanged ? "output keeps changing oddly" : `no new output for ${item.sinceLastOutputSec}s`}`;

      if (item.kind === "bash") {
        const action = settings.action;
        if (action === "kill" && process.platform !== "win32") {
          const candidates = findBashChildren(process.pid, item.command);
          if (candidates.pids.length === 1) {
            killProcessGroup(candidates.pgids[0]!, candidates.pids[0]!, 1);
            state.kills.set(itemKeyToolCallId(item.key), {
              toolCallId: itemKeyToolCallId(item.key),
              durationMs,
              reason: `${decision.signal}; ${reason}`,
            });
            state.bash.delete(itemKeyToolCallId(item.key));
            debugLog(`killed bash ${item.command} (${reason})`);
            continue;
          }
          debugLog(
            `bash ${item.command}: ${candidates.pids.length} child matches — downgraded to warn`,
          );
        }
        queueWarn(item, decision, reason);
      } else if (item.kind === "bg" && item.task) {
        const registry = getSharedTaskRegistry();
        const task = registry?.allTasks().find((t) => t.id === item.task!.id);
        if (registry && task && task.status === "running") {
          try {
            await registry.stopTask(task, "watchdog", `killed by unipi watchdog: ${reason}`);
            debugLog(`killed bg task ${item.task.id} (${reason})`);
          } catch (err) {
            debugLog(`bg kill failed for ${item.task.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
      } else if (item.kind === "other") {
        if (settings.otherTools === "abort-turn" && ctx.hasUI) {
          const text = `⚠ Watchdog aborted "${item.toolName}": jev judged it ${reason}.`;
          try {
            ctx.abort();
            piSend(text);
          } catch {
            // best-effort
          }
        } else if (settings.otherTools === "warn") {
          queueWarn(item, decision, reason);
          if (ctx.hasUI) ctx.ui.notify(`⚠ Watchdog: "${item.toolName}" looks ${decision.status}.`, "warning");
        }
      }
    }

    // Remember tails for the next tick's "output changed" comparison.
    for (const item of items) seen.set(item.key, item.tail);
    applySeen(seen);
  } finally {
    state.busy = false;
  }
}

/** Per-key tail memory for the outputChanged comparison. */
const tailMemory = new Map<string, string>();

function applySeen(seen: Map<string, string>): void {
  tailMemory.clear();
  for (const [key, tail] of seen) tailMemory.set(key, tail);
}

function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args === "object") {
    const record = args as Record<string, unknown>;
    for (const key of ["command", "url", "query", "prompt", "promptText"]) {
      const v = record[key];
      if (typeof v === "string" && v) return v.slice(0, 300);
    }
    try {
      return JSON.stringify(args).slice(0, 300);
    } catch {
      return "[unserializable args]";
    }
  }
  return String(args).slice(0, 300);
}

function itemKeyToolCallId(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

function queueWarn(item: WatchedItem, decision: { status: string; confidence: number; streak: number }, reason: string): void {
  state.pending.push(
    `⚠ Watchdog: "${item.toolName}" looks ${decision.status} ` +
    `(confidence ${decision.confidence.toFixed(2)}, ${decision.streak} consecutive checks): ${reason}.`,
  );
}

function piSend(content: string): void {
  state.pi?.sendUserMessage(content, { deliverAs: "followUp" });
}
