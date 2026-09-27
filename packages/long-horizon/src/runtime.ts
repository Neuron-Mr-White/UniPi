/**
 * Runtime wiring — connects the engine to pi events.
 *
 *   tool_call    → TurnActivity accumulation (bash commands, edit/write
 *                  files, call count)
 *   agent_end    → extract recent tail + token totals, run continuation
 *                  settlement, deliver the next message
 *   continuation.send → pi.sendUserMessage (a follow-up user turn: the gate
 *                  re-resolves, the owner wins, the loop continues)
 *   verifier     → modelRegistry.complete on the session model (or the
 *                  configured verifier model)
 *
 * The loop closes here: agent_end → settle → sendUserMessage → next turn →
 * agent_end … bounded by maxTurns / stall cap / token budget.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalMachine } from "./engine/goal-state.js";
import type { GoalToolset } from "./tools/goal.js";
import type { GoalContinuation, TurnActivity } from "./engine/continuation.js";
import type { VerifierEvaluate } from "./engine/verifier.js";
import type { Gate } from "./gate.js";
import type { RalphLoop } from "./engine/ralph.js";
import type { LongHorizonSettings } from "./settings.js";
import { loadSettings } from "./settings.js";
import { RunawayGuard } from "./engine/runaway.js";
import { appendProgress, registerProgressRenderer, UNIPI_EVENTS } from "@pi-unipi/core";
import { goalEstimatePrompt, goalProgressData, parseEstimate, type GoalEvidence } from "./progress.js";
import { TERMINAL_GOAL_STATUSES } from "./engine/goal-state.js";

/** Extract command/file signals from a tool call for the activity record. */
export function classifyToolCall(
  toolName: string,
  input: unknown,
): { command?: string; file?: string } {
  const record = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return undefined;
  };
  switch (toolName) {
    case "bash":
    case "powershell": {
      const command = firstString("command", "cmd", "script");
      return command !== undefined ? { command } : {};
    }
    case "edit":
    case "write":
    case "read": {
      const file = firstString("path", "file_path", "file");
      return file !== undefined ? { file } : {};
    }
    default:
      return {};
  }
}

function messageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text"
          ? String((part as Record<string, unknown>).text ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

/** Bounded recent tail (last N, role + text) for evidence briefs. */
export function extractTail(
  messages: readonly unknown[],
  limit = 5,
): Array<{ role: string; text: string }> {
  return messages
    .slice(-limit)
    .map((message) => {
      const role =
        typeof message === "object" && message !== null
          ? String((message as Record<string, unknown>).role ?? "unknown")
          : "unknown";
      return { role, text: messageText(message).slice(0, 800) };
    })
    .filter((entry) => entry.text.length > 0);
}

/** Best-effort cumulative token count from assistant usage fields. */
export function sumUsageTokens(messages: readonly unknown[]): number | undefined {
  let total = 0;
  let seen = false;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const usage = (message as Record<string, unknown>).usage;
    if (typeof usage !== "object" || usage === null) continue;
    const record = usage as Record<string, unknown>;
    if (typeof record.totalTokens === "number") {
      total += record.totalTokens;
      seen = true;
      continue;
    }
    const input = typeof record.inputTokens === "number" ? record.inputTokens : 0;
    const output = typeof record.outputTokens === "number" ? record.outputTokens : 0;
    if (input + output > 0) {
      total += input + output;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

export interface RuntimeDeps {
  readonly machine: GoalMachine;
  readonly toolset: GoalToolset;
  readonly continuation: GoalContinuation;
  readonly gate: Gate;
  readonly ralph?: RalphLoop;
  readonly loadSettings?: () => LongHorizonSettings;
}

interface EvalContext {
  registry: ExtensionContext["modelRegistry"];
  model: ExtensionContext["model"];
}

export interface RuntimeHandle {
  /** Estimate goal progress now and post it (user-only). */
  estimateGoal(ctx?: ExtensionContext): Promise<"ok" | "none" | "failed">;
}

export function wireRuntime(pi: ExtensionAPI, deps: RuntimeDeps): RuntimeHandle {
  const settings = deps.loadSettings ?? loadSettings;
  registerProgressRenderer(pi);

  // ── per-turn activity accumulator ───────────────────────────────────
  let toolCalls = 0;
  let commands: string[] = [];
  let changedFiles: string[] = [];

  pi.on("tool_call", (event) => {
    try {
      const toolEvent = event as { toolName?: string; input?: unknown };
      if (typeof toolEvent.toolName !== "string") return;
      if (deps.gate.current()?.mode === "none") return; // plain turns don't feed the loop
      toolCalls += 1;
      const classified = classifyToolCall(toolEvent.toolName, toolEvent.input);
      if (classified.command) commands.push(classified.command.slice(0, 200));
      if (classified.file) changedFiles.push(classified.file.slice(0, 200));
    } catch {
      // Instrumentation must never abort a turn.
    }
  });

  // ── runaway guard: feed steps, steer once per turn ─────────────────
  const runaway = new RunawayGuard({
    steer: (text) => {
      void pi.sendUserMessage(text, { deliverAs: "steer" });
    },
  });
  pi.on("tool_execution_end", (event) => {
    try {
    const toolEvent = event as { toolName?: string; result?: unknown; isError?: boolean };
    if (typeof toolEvent.toolName !== "string") return;
    const resultText =
      typeof toolEvent.result === "string"
        ? toolEvent.result
        : (() => {
            try {
              return JSON.stringify(toolEvent.result ?? "");
            } catch {
              return String(toolEvent.result ?? "");
            }
          })();
    runaway.feed({
      tool: toolEvent.toolName,
      input: (event as { input?: unknown }).input,
      resultText: resultText.slice(0, 400),
      isError: toolEvent.isError === true,
    });
    } catch {
      // Detector instrumentation must never abort a turn.
    }
  });

  // ── agent_end → continuation settlement ─────────────────────────────
  let evalContext: EvalContext | null = null;

  pi.on("agent_end", async (event, ctx) => {
    try {
    runaway.resetTurn();
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    evalContext = { registry: ctx.modelRegistry, model: ctx.model };

    const activity: TurnActivity = {
      toolCalls,
      changedFiles,
      commands,
      recentTail: extractTail(messages),
    };
    // Reset for the next turn before awaiting settlement.
    toolCalls = 0;
    commands = [];
    changedFiles = [];

    const tokens = sumUsageTokens(messages);
    // Only update when this turn actually reported usage — a usage-less turn
    // keeps the last known counter (and never erases an injected one).
    if (tokens !== undefined) deps.continuation.setTokenCounter(() => tokens);
    if (deps.machine.get()) lastEvidence = activity;
    await deps.continuation.onTurnEnd(activity);
    // Per-loop goal progress: fire-and-forget, never delays the next turn.
    if (settings().goalProgress === "loop") void estimateGoal(ctx, true);
    } catch {
      // Settlement failures must never surface as turn aborts.
    }
  });

  // ── goal progress estimate (one-off side call, never in context) ─────
  let lastEvidence: GoalEvidence | undefined;
  let lastPercent: number | undefined;
  let lastGoalKey: string | undefined;
  let estimating = false;

  async function estimateGoal(ctx?: ExtensionContext, fromLoop = false): Promise<"ok" | "none" | "failed"> {
    try {
      const goal = deps.machine.get();
      if (!goal || deps.ralph?.get()?.status === "active") return "none"; // ralph has its own bar
      const key = `${goal.goalId}:${goal.status}`;
      const terminal = TERMINAL_GOAL_STATUSES.has(goal.status);
      // A loop posts once per goal turn; a finished goal posts its last bar once.
      if (fromLoop && (goal.status === "paused" || (terminal && key === lastGoalKey))) return "none";
      if (goal.goalId !== lastGoalKey?.split(":")[0]) lastPercent = undefined;
      lastGoalKey = key;
      if (goal.status === "complete") {
        appendProgress(pi, goalProgressData(goal, 100, "Objective met."));
        return "ok";
      }
      if (estimating) return "ok";
      estimating = true;
      const s = settings();
      const text = await complete(s.progressModel || s.verifierModel, goalEstimatePrompt(goal, lastEvidence, lastPercent), undefined, ctx);
      const est = parseEstimate(text);
      if (!est) return "failed";
      lastPercent = est.percent;
      appendProgress(pi, goalProgressData(deps.machine.get() ?? goal, est.percent, est.summary));
      return "ok";
    } catch {
      return "failed";
    } finally {
      estimating = false;
    }
  }

  // ── one-shot completions (verifier, progress) → modelRegistry.complete ─
  async function complete(configured: string, prompt: string, signal?: AbortSignal, ctx?: ExtensionContext): Promise<string> {
    const context = ctx ? { registry: ctx.modelRegistry, model: ctx.model } : evalContext;
    if (!context?.model || !context.registry) {
      throw new Error("verifier: no model context available yet");
    }
    let model = context.model;
    if (configured) {
      const slash = configured.indexOf("/");
      if (slash > 0) {
        const found = context.registry.find(
          configured.slice(0, slash),
          configured.slice(slash + 1),
        );
        if (found) model = found;
      }
    }
    const message = await context.registry.complete(model, {
      messages: [{ role: "user", content: prompt }],
      ...(signal ? { signal } : {}),
    } as never);
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .map((part) =>
                part && typeof part === "object" && "text" in part ? String(part.text) : "",
              )
              .join("")
          : "";
    if (!text) throw new Error("verifier: empty completion");
    return text;
  }
  const evaluate: VerifierEvaluate = (prompt, signal) => complete(settings().verifierModel, prompt, signal);
  deps.continuation.setEvaluate(evaluate);
  if (deps.ralph) deps.ralph.setEvaluate(evaluate);

  // ── compaction → recovery fragment on the next continuation ─────────
  pi.on("session_compact", () => {
    deps.continuation.armRecovery();
  });
  // Boundary compactions (compactor's percentage trigger) don't fire
  // session_compact; the compactor announces them on the event bus.
  pi.events?.on?.(UNIPI_EVENTS.COMPACTOR_COMPACTED, () => {
    deps.continuation.armRecovery();
  });

  return { estimateGoal: (ctx) => estimateGoal(ctx) };
}
