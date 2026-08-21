/**
 * @pi-unipi/subagents — Turn / tool / usage budgets
 *
 * Ported from pi-subagents src/runs/shared/{turn-budget,tool-budget,
 * usage-budget}.ts. Semantics identical; env override uses OUR prefix
 * (UNIPI_SUBAGENT_TOOL_BUDGET). In-process foreground children enforce the
 * turn budget at assistant-turn boundaries and the tool budget by blocking
 * tools past the hard cap.
 */

import type {
  ResolvedTurnBudget,
  ResolvedToolBudget,
  ToolBudgetConfig,
  TurnBudgetState,
  ToolBudgetState,
  UsageBudgetConfig,
} from "./parity-types.js";

// ============================================================================
// Turn budget
// ============================================================================

export const DEFAULT_TURN_BUDGET_GRACE_TURNS = 1;

export function resolveTurnBudgetConfig(
  raw: unknown,
  label = "turnBudget",
): { turnBudget?: ResolvedTurnBudget; error?: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${label} must be an object with maxTurns and optional graceTurns.` };
  }
  const unknownField = Object.keys(raw as Record<string, unknown>).find(
    (key) => key !== "maxTurns" && key !== "graceTurns",
  );
  if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
  const budget = raw as { maxTurns?: unknown; graceTurns?: unknown };
  if (typeof budget.maxTurns !== "number" || !Number.isInteger(budget.maxTurns) || budget.maxTurns < 1) {
    return { error: `${label}.maxTurns must be an integer >= 1.` };
  }
  const graceTurns = budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS;
  if (typeof graceTurns !== "number" || !Number.isInteger(graceTurns) || graceTurns < 0) {
    return { error: `${label}.graceTurns must be an integer >= 0.` };
  }
  return { turnBudget: { maxTurns: budget.maxTurns, graceTurns } };
}

export function appendTurnBudgetSystemPrompt(
  systemPrompt: string,
  budget: { maxTurns: number; graceTurns?: number } | undefined,
): string {
  if (!budget) return systemPrompt;
  const graceTurns = budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS;
  const grace = graceTurns === 1 ? "1 additional assistant turn" : `${graceTurns} additional assistant turns`;
  const block = [
    "## Turn budget",
    `This child run has a soft budget of ${budget.maxTurns} assistant turn${budget.maxTurns === 1 ? "" : "s"}.`,
    `After that, ${grace} may be allowed only for a final wrap-up.`,
    "When you approach or reach the soft budget, stop starting new tool work and return the final answer immediately.",
    "If you continue past the soft budget plus grace turns, the supervisor may abort the run and return only partial output.",
  ].join("\n");
  return systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${block}` : block;
}

export function turnBudgetSoftNote(budget: ResolvedTurnBudget, turnCount: number): string {
  return `Turn budget wrap-up was requested after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns}, grace ${budget.graceTurns}). Output may be partial.`;
}

export function turnBudgetExceededMessage(budget: ResolvedTurnBudget, turnCount: number): string {
  return `Subagent exceeded turn budget after ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}).`;
}

export function turnBudgetDeferredNote(budget: ResolvedTurnBudget, turnCount: number): string {
  return `Turn-budget termination was deferred at ${turnCount} assistant turn${turnCount === 1 ? "" : "s"} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}) because the assistant started tool work. The run ended before another safe assistant boundary; output may be partial.`;
}

export function formatTurnBudgetOutput(message: string, output: string): string {
  return output.trim()
    ? `${message}\n\nPartial output before turn-budget abort:\n${output}`
    : message;
}

export function turnBudgetDecision(
  budget: ResolvedTurnBudget,
  turnCount: number,
  terminalAssistantStop: boolean,
  toolWorkActiveOrStarting: boolean,
  enforceHardLimit = false,
): "continue" | "defer" | "abort" {
  const hardLimit = budget.maxTurns + budget.graceTurns;
  if (terminalAssistantStop || turnCount < hardLimit) return "continue";
  if (toolWorkActiveOrStarting && !enforceHardLimit) return "defer";
  return "abort";
}

export function turnBudgetState(
  budget: ResolvedTurnBudget,
  turnCount: number,
  exceeded: boolean,
): TurnBudgetState {
  return {
    ...budget,
    turns: turnCount,
    outcome: exceeded ? "exceeded" : "wrap-up-requested",
  };
}

// ============================================================================
// Tool budget
// ============================================================================

export const DEFAULT_TOOL_BUDGET_BLOCK = ["read", "grep", "find", "ls"] as const;
export const TOOL_BUDGET_ENV = "UNIPI_SUBAGENT_TOOL_BUDGET";

export function normalizeToolBudgetBlock(block: ToolBudgetConfig["block"] | undefined): "*" | string[] {
  if (block === "*") return "*";
  if (block === undefined) return [...DEFAULT_TOOL_BUDGET_BLOCK];
  return [...new Set(block.map((tool) => tool.trim()).filter(Boolean))];
}

export function validateToolBudgetConfig(
  raw: unknown,
  label = "toolBudget",
  options: { minimumHard?: 0 | 1 } = {},
): { budget?: ResolvedToolBudget; error?: string } {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `${label} must be an object with hard and optional soft/block.` };
  }
  const value = raw as ToolBudgetConfig;
  const minimumHard = options.minimumHard ?? 1;
  if (typeof value.hard !== "number" || !Number.isInteger(value.hard) || value.hard < minimumHard) {
    return { error: `${label}.hard must be an integer >= ${minimumHard}.` };
  }
  if (value.soft !== undefined && (typeof value.soft !== "number" || !Number.isInteger(value.soft) || value.soft < 1)) {
    return { error: `${label}.soft must be an integer >= 1 when provided.` };
  }
  if (value.soft !== undefined && value.soft > value.hard) {
    return { error: `${label}.soft must be <= ${label}.hard.` };
  }
  if (value.block !== undefined && value.block !== "*") {
    if (!Array.isArray(value.block)) return { error: `${label}.block must be "*" or an array of tool names.` };
    if (value.block.length === 0) return { error: `${label}.block must contain at least one tool name.` };
    for (const item of value.block) {
      if (typeof item !== "string" || !item.trim()) return { error: `${label}.block must contain non-empty tool names.` };
    }
  }
  return {
    budget: {
      hard: value.hard,
      ...(value.soft !== undefined ? { soft: value.soft } : {}),
      block: normalizeToolBudgetBlock(value.block),
    },
  };
}

export function shouldBlockToolForBudget(
  budget: ResolvedToolBudget,
  toolName: string,
  nextToolCount: number,
): boolean {
  if (nextToolCount <= budget.hard) return false;
  return budget.block === "*" || budget.block.includes(toolName);
}

export function toolBudgetSoftNudge(budget: ResolvedToolBudget, toolCount: number): string {
  return `Tool budget soft limit reached after ${toolCount} tool call${toolCount === 1 ? "" : "s"} (soft ${budget.soft}, hard ${budget.hard}). Stop starting new browsing/search work and finalize from the context you already have.`;
}

export function toolBudgetBlockedMessage(budget: ResolvedToolBudget, toolName: string, toolCount: number): string {
  return `Tool budget hard limit reached after ${toolCount} tool call${toolCount === 1 ? "" : "s"} (hard ${budget.hard}). The '${toolName}' tool is blocked so you can finalize from the context you already have.`;
}

export function toolBudgetState(
  budget: ResolvedToolBudget,
  toolCount: number,
  blockedTool?: string,
): ToolBudgetState {
  const overHard = toolCount > budget.hard;
  const overSoft = budget.soft !== undefined && toolCount >= budget.soft;
  return {
    ...budget,
    toolCalls: toolCount,
    outcome: overHard ? "hard-blocked" : overSoft ? "soft-reached" : "within-budget",
  };
}

// ============================================================================
// Usage budget
// ============================================================================

export interface UsageBudgetLimitConfig {
  soft?: number;
  hard: number;
}

export interface UsageBudgetState {
  version: 1;
  source: "reported";
  tokens?: UsageBudgetLimitConfig & { used: number; outcome: "within-budget" | "soft-exceeded" | "hard-exceeded" };
  costUsd?: UsageBudgetLimitConfig & { used: number; outcome: "within-budget" | "soft-exceeded" | "hard-exceeded" };
  exhausted: boolean;
  reason?: "tokens" | "costUsd";
}

function validateLimit(raw: unknown, label: string): { limit?: UsageBudgetLimitConfig; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} must be an object with hard and optional soft.` };
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => key !== "soft" && key !== "hard");
  if (unknown) return { error: `${label}.${unknown} is not supported.` };
  if (typeof value.hard !== "number" || !Number.isFinite(value.hard) || value.hard <= 0) {
    return { error: `${label}.hard must be a positive number.` };
  }
  if (value.soft !== undefined && (typeof value.soft !== "number" || !Number.isFinite(value.soft) || value.soft <= 0)) {
    return { error: `${label}.soft must be a positive number when provided.` };
  }
  if (value.soft !== undefined && value.soft > value.hard) {
    return { error: `${label}.soft must be <= ${label}.hard.` };
  }
  return { limit: { hard: value.hard, ...(value.soft !== undefined ? { soft: value.soft } : {}) } };
}

export function validateUsageBudgetConfig(value: unknown, label = "usageBudget"): { budget?: UsageBudgetConfig; error?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${label} must be an object.` };
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => key !== "tokens" && key !== "costUsd");
  if (unknown) return { error: `${label}.${unknown} is not supported.` };
  const budget: UsageBudgetConfig = {};
  if (raw.tokens !== undefined) {
    const tokens = validateLimit(raw.tokens, `${label}.tokens`);
    if (tokens.error) return { error: tokens.error };
    if (tokens.limit) budget.tokens = tokens.limit;
  }
  if (raw.costUsd !== undefined) {
    const costUsd = validateLimit(raw.costUsd, `${label}.costUsd`);
    if (costUsd.error) return { error: costUsd.error };
    if (costUsd.limit) budget.costUsd = costUsd.limit;
  }
  if (!budget.tokens && !budget.costUsd) return { error: `${label} must include tokens or costUsd.` };
  return { budget };
}

function metricState(
  limit: UsageBudgetLimitConfig | undefined,
  used: number,
): UsageBudgetState["tokens"] {
  if (!limit) return undefined;
  return {
    ...limit,
    used,
    outcome: used >= limit.hard ? "hard-exceeded" : limit.soft !== undefined && used >= limit.soft ? "soft-exceeded" : "within-budget",
  };
}

export function usageBudgetState(
  config: UsageBudgetConfig | undefined,
  totals: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined,
): UsageBudgetState | undefined {
  if (!config) return undefined;
  const inputTokens = totals?.inputTokens ?? 0;
  const outputTokens = totals?.outputTokens ?? 0;
  const tokens = metricState(config.tokens, inputTokens + outputTokens);
  const costUsd = metricState(config.costUsd, totals?.costUsd ?? 0);
  const reason = tokens?.outcome === "hard-exceeded" ? "tokens" : costUsd?.outcome === "hard-exceeded" ? "costUsd" : undefined;
  return {
    version: 1,
    source: "reported",
    ...(tokens ? { tokens } : {}),
    ...(costUsd ? { costUsd } : {}),
    exhausted: reason !== undefined,
    ...(reason ? { reason } : {}),
  };
}

export function usageBudgetExceededMessage(state: UsageBudgetState): string {
  if (state.reason === "tokens" && state.tokens) {
    return `Usage budget exhausted: reported tokens ${state.tokens.used} reached hard limit ${state.tokens.hard}.`;
  }
  if (state.reason === "costUsd" && state.costUsd) {
    return `Usage budget exhausted: reported cost $${state.costUsd.used.toFixed(6)} reached hard limit $${state.costUsd.hard.toFixed(6)}.`;
  }
  return "Usage budget exhausted.";
}
