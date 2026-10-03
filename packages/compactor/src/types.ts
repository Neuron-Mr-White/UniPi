/**
 * @pi-unipi/compactor — Shared TypeScript types
 */

// ─────────────────────────────────────────────────────────
// Normalized blocks (from pi-vcc)
// ─────────────────────────────────────────────────────────

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; isError: boolean; sourceIndex?: number }
  | { kind: "thinking"; text: string; redacted: boolean; sourceIndex?: number };

/** Hook-provided file activity (pi-vcc parity) — structural signal for ranking */
export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

// ─────────────────────────────────────────────────────────
// Compaction stats
// ─────────────────────────────────────────────────────────

export interface CompactionStats {
  summarized: number;
  kept: number;
  totalMessages?: number;
  /** Actual token count from Pi's preparation */
  tokensBefore?: number;
  /** Estimated tokens after compaction: summary + kept tail. */
  tokensAfterEst?: number;
  keptUserTurns: number;
  totalUserTurns: number;
  requestedKeepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  keepFallbackToCompactAll: boolean;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
  /** Base keep before smart adjustment (for toast like "1→3"). */
  smartFromKeep?: number;
}

export type BudgetCutKind = "no_anchor" | "oversized_tail";

// ─────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────

/**
 * vcc = UniPi's lossless zero-LLM summary; llm = a model-written summary.
 */
export type CompactionMethod = "vcc" | "llm";

/** Summary sections that can be switched off (Advanced). */
export interface SummarySections {
  activeWork: boolean;
  requests: boolean;
  state: boolean;
  decisions: boolean;
  files: boolean;
  commits: boolean;
  errors: boolean;
  lessons: boolean;
  transcript: boolean;
}

export interface CompactorConfig {
  /** How automatic compactions are summarized. */
  method: CompactionMethod;
  /** What Pi's own /compact does: follow `method`, or force one. */
  piCompact: "follow" | CompactionMethod;
  /** When to compact: Pi's own context limit, or a percentage of the window. */
  trigger: "pi" | "percent";
  /** Context % that triggers compaction when trigger = "percent". */
  thresholdPercent: number;
  /** Notices when compaction runs or fails. */
  notify: boolean;

  // ── Advanced ──
  /** Grow the kept tail when it would be tiny (≤5k tok, capped 25k). */
  smartKeepTail: boolean;
  /** Lossless summary budget in tokens; 0 = auto (scales with session size). */
  summaryBudgetTokens: number;
  sections: SummarySections;
  /** Hub multiselect form of `sections`; present → sections derives from it. */
  summarySections?: string[];
  /** Extra instructions for model-written summaries. */
  llmInstructions: string;
}

/** Percentage auto-compaction trigger settings (decision input). */
export interface AutoCompactionConfig {
  enabled: boolean;
  /** Trigger when Pi reports context usage at or above this percent (0-100 scale). */
  thresholdPercent: number;
  /** Minimum delay between UniPi-triggered compaction attempts. */
  cooldownMs: number;
  /** When usage stays above threshold after compaction, require this many new tokens before repeating. */
  repeatMinGrowthTokens: number;
  /** Show user notifications for UniPi-triggered compaction attempts/results. */
  notify: boolean;
}

export interface RuntimeCounters {
  recallQueries: number;
  compactions: number;
}
