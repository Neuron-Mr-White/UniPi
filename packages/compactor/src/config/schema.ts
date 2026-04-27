/**
 * Compactor configuration schema with defaults
 */

import type { CompactorConfig, CompactorStrategyConfig } from "../types.js";

const strategy = (enabled: boolean, mode: string): CompactorStrategyConfig => ({
  enabled,
  mode,
});

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  sessionGoals: { ...strategy(true, "full"), mode: "full" },
  filesAndChanges: { ...strategy(true, "all"), mode: "all", maxPerCategory: 10 },
  commits: { ...strategy(true, "full"), mode: "full", maxCommits: 8 },
  outstandingContext: { ...strategy(true, "full"), mode: "full", maxItems: 5 },
  userPreferences: { ...strategy(true, "all"), mode: "all", maxPreferences: 10 },
  briefTranscript: {
    ...strategy(true, "full"),
    mode: "full",
    userTokenLimit: 256,
    assistantTokenLimit: 200,
    toolCallLimit: 8,
  },
  sessionContinuity: {
    ...strategy(true, "full"),
    mode: "full",
    eventCategories: [],
  },
  fts5Index: {
    ...strategy(true, "manual"),
    mode: "manual",
    chunkSize: 4096,
    cacheTtlHours: 24,
  },
  sandboxExecution: {
    ...strategy(true, "all"),
    mode: "all",
    allowedLanguages: ["javascript", "typescript", "python", "shell"],
    outputLimit: 100 * 1024 * 1024,
  },
  toolDisplay: {
    ...strategy(true, "opencode"),
    mode: "opencode",
    diffLayout: "auto",
    diffIndicator: "bars",
    showThinkingLabels: true,
    showUserMessageBox: true,
    showBashSpinner: true,
    showPendingPreviews: true,
  },
  overrideDefaultCompaction: false,
  debug: false,
  showTruncationHints: true,
};
