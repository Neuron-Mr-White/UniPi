/**
 * Compactor configuration schema with defaults
 */

import type { AutoCompactionConfig, CompactorConfig } from "../types.js";

/** Percentage-trigger tuning, fixed since the settings were pruned (UNI-50). */
export const COOLDOWN_MS = 60_000;
export const REPEAT_MIN_GROWTH_TOKENS = 4_000;

/** Summary-section ids in canonical order (hub multiselect `summarySections`). */
export const SUMMARY_SECTION_IDS = [
  "activeWork",
  "requests",
  "state",
  "decisions",
  "files",
  "commits",
  "errors",
  "lessons",
  "transcript",
] as const;

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
  summarySections: [...SUMMARY_SECTION_IDS],
  llmInstructions: "",
};

/** The percentage-trigger view of a config (input to decideAutoCompaction). */
export function autoCompactionOf(config: CompactorConfig): AutoCompactionConfig {
  return {
    enabled: config.trigger === "percent",
    thresholdPercent: config.thresholdPercent,
    cooldownMs: COOLDOWN_MS,
    repeatMinGrowthTokens: REPEAT_MIN_GROWTH_TOKENS,
    notify: config.notify,
  };
}
