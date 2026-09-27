/**
 * Compactor configuration schema with defaults
 */

import type { AutoCompactionConfig, CompactorConfig } from "../types.js";

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  method: "vcc",
  piCompact: "follow",
  trigger: "pi",
  thresholdPercent: 80,
  notify: true,
  smartKeepTail: true,
  summaryBudgetTokens: 0,
  sections: {
    activeWork: true,
    requests: true,
    state: true,
    decisions: true,
    files: true,
    commits: true,
    errors: true,
    lessons: true,
    transcript: true,
  },
  cooldownMs: 60_000,
  repeatMinGrowthTokens: 4_000,
  llmInstructions: "",
  debug: false,
};

/** The percentage-trigger view of a config (input to decideAutoCompaction). */
export function autoCompactionOf(config: CompactorConfig): AutoCompactionConfig {
  return {
    enabled: config.trigger === "percent",
    thresholdPercent: config.thresholdPercent,
    cooldownMs: config.cooldownMs,
    repeatMinGrowthTokens: config.repeatMinGrowthTokens,
    notify: config.notify,
  };
}
