/**
 * context_budget tool — estimate remaining context window
 */

import type { CompactorConfig } from "../types.js";

export interface ContextBudgetResult {
  percentFull: number;
  remainingTokens: number;
  totalTokens: number;
  message: string;
  advice: string;
}

export function estimateContextBudget(
  tokensUsed?: number,
  contextWindowSize?: number,
  config?: Pick<CompactorConfig, "trigger" | "thresholdPercent">,
): ContextBudgetResult | null {
  if (tokensUsed === undefined) return null;
  const windowSize = contextWindowSize ?? 200000;
  const used = Math.max(0, tokensUsed);
  const remaining = Math.max(0, windowSize - used);
  const percentFull = windowSize > 0 ? Math.round((used / windowSize) * 100) : 0;

  let advice: string;
  if (config?.trigger === "percent") {
    advice = percentFull >= config.thresholdPercent
      ? `Context will be compacted automatically at the next turn boundary (threshold ${config.thresholdPercent}%). Keep working.`
      : `Context compacts automatically at ${config.thresholdPercent}%. Keep working.`;
  } else {
    advice = percentFull >= 85
      ? "Context is nearly full; Pi compacts automatically near the limit and the work continues. Keep working."
      : "Plenty of room. Pi compacts automatically near the limit.";
  }

  const message = `Context: ~${percentFull}% full (estimated ${remaining.toLocaleString()} tokens remaining)`;
  return { percentFull, remainingTokens: remaining, totalTokens: windowSize, message, advice };
}

export function contextBudgetTool(
  tokensUsed?: number,
  contextWindowSize?: number,
  config?: Pick<CompactorConfig, "trigger" | "thresholdPercent">,
): string {
  const budget = estimateContextBudget(tokensUsed, contextWindowSize, config);
  if (!budget) return "Context budget: unknown (no token data available yet).";
  return `${budget.message}\nAdvice: ${budget.advice}`;
}
