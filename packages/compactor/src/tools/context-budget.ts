/**
 * context_budget tool — estimate remaining context window
 */

export interface ContextBudgetResult {
  percentFull: number;
  remainingTokens: number;
  totalTokens: number;
  message: string;
  advice: string;
}

export function estimateContextBudget(
  tokensBefore?: number,
  contextWindowSize?: number,
): ContextBudgetResult | null {
  const windowSize = contextWindowSize ?? 200000; // Default 200K context
  const used = tokensBefore ?? 0;

  if (used <= 0 && tokensBefore === undefined) return null;

  const remaining = Math.max(0, windowSize - used);
  const percentFull = windowSize > 0 ? Math.round((used / windowSize) * 100) : 0;

  let advice: string;
  if (percentFull >= 90) {
    advice = "CRITICAL: Compact immediately. Very little room for complex tasks.";
  } else if (percentFull >= 75) {
    advice = "Context is filling up. Compact before starting complex work.";
  } else if (percentFull >= 50) {
    advice = "Moderate context usage. Compact before large multi-step tasks.";
  } else {
    advice = "Context has plenty of room. No compaction needed yet.";
  }

  const message = `Context: ~${percentFull}% full (estimated ${remaining.toLocaleString()} tokens remaining)`;

  return { percentFull, remainingTokens: remaining, totalTokens: windowSize, message, advice };
}

/**
 * The context_budget tool handler.
 * Called from the tool registration — receives tokensBefore from Pi context.
 */
export function contextBudgetTool(tokensBefore?: number): string {
  const budget = estimateContextBudget(tokensBefore);
  if (!budget) return "Context budget: Unknown (no token data available from session).";

  return `${budget.message}\nAdvice: ${budget.advice}`;
}
