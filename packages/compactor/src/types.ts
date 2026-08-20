/**
 * @pi-unipi/compactor — Shared TypeScript types
 */

import type { Message } from "@earendil-works/pi-ai";

// ─────────────────────────────────────────────────────────
// Normalized blocks (from pi-vcc)
// ─────────────────────────────────────────────────────────

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; isError: boolean; sourceIndex?: number }
  | { kind: "thinking"; text: string; redacted: boolean; sourceIndex?: number };

// ─────────────────────────────────────────────────────────
// Section data (from pi-vcc)
// ─────────────────────────────────────────────────────────

export interface SectionData {
  sessionGoal: string[];
  filesAndChanges: string[];
  commits: string[];
  outstandingContext: string[];
  userPreferences: string[];
  briefTranscript: string;
}

export interface BriefLine {
  header: string;
  lines: string[];
}

// ─────────────────────────────────────────────────────────
// Compaction input / output
// ─────────────────────────────────────────────────────────

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
}

export interface CompactionStats {
  summarized: number;
  kept: number;
  totalMessages: number;
  /** Actual token count from Pi's preparation */
  tokensBefore: number;
  /** Estimated tokens after compaction (proportional from kept/total chars) */
  tokensAfterEst: number;
}

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages"
  | "no_user_message";

export type OwnCutResult =
  | { ok: true; messages: Message[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

// ─────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────

export interface CompactorStrategyConfig {
  enabled: boolean;
  mode: string;
  autoDetect?: "git" | null;
}

/** UniPi-managed percentage auto-compaction trigger settings. */
export interface AutoCompactionConfig {
  /** Enable the extension-managed percentage trigger. Disabled by default for backward compatibility. */
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

export interface CompactorConfig {
  // Compaction strategies
  sessionGoals: CompactorStrategyConfig & { mode: "full" | "brief" | "off" };
  filesAndChanges: CompactorStrategyConfig & { mode: "all" | "modified-only" | "off"; maxPerCategory: number };
  commits: CompactorStrategyConfig & { mode: "full" | "brief" | "off"; maxCommits: number };
  outstandingContext: CompactorStrategyConfig & { mode: "full" | "critical-only" | "off"; maxItems: number };
  userPreferences: CompactorStrategyConfig & { mode: "all" | "recent-only" | "off"; maxPreferences: number };
  briefTranscript: CompactorStrategyConfig & { mode: "full" | "compact" | "minimal" | "off"; userTokenLimit: number; assistantTokenLimit: number; toolCallLimit: number };
  sessionContinuity: CompactorStrategyConfig & {
    mode: "full" | "essential-only" | "off";
    /** @deprecated Category filtering was never implemented; ignored by runtime. */
    eventCategories: string[];
  };
  /** @deprecated Project indexing moved to @pi-unipi/cocoindex; retained for config compatibility. */
  fts5Index: CompactorStrategyConfig & { mode: "auto" | "manual" | "off"; chunkSize: number; cacheTtlHours: number };
  sandboxExecution: CompactorStrategyConfig & { mode: "all" | "safe-only" | "off"; allowedLanguages: Language[]; outputLimit: number };

  // Pipeline features
  pipeline: {
    autoInjection: boolean;
    customNoisePatterns: string[];
  };

  // Auto compaction trigger
  autoCompaction: AutoCompactionConfig;

  // Global settings
  overrideDefaultCompaction: boolean;
}

export type CompactorPreset = "precise" | "balanced" | "thorough" | "lean" | "opencode" | "verbose" | "minimal" | "custom";

// ─────────────────────────────────────────────────────────
// Session events (from context-mode)
// ─────────────────────────────────────────────────────────

export interface SessionEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  data_hash: string;
  project_dir?: string;
  attribution_source?: string;
  attribution_confidence?: number;
}

export interface StoredEvent {
  id: number;
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  project_dir: string;
  attribution_source: string;
  attribution_confidence: number;
  source_hook: string;
  created_at: string;
  data_hash: string;
}

export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
}

export interface ResumeRow {
  snapshot: string;
  event_count: number;
  consumed: number;
}

export interface ResumeSnapshot {
  generatedAt: string;
  summary: string;
  events: SessionEvent[];
}

// ─────────────────────────────────────────────────────────
// Execution (from context-mode)
// ─────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  backgrounded?: boolean;
}

export type Language =
  | "javascript"
  | "typescript"
  | "python"
  | "shell"
  | "ruby"
  | "go"
  | "rust"
  | "php"
  | "perl"
  | "r"
  | "elixir";

// ─────────────────────────────────────────────────────────
// Content store — REMOVED (moved to @pi-unipi/cocoindex)
// SearchResult, IndexResult, StoreStats types no longer needed.
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// Security (from context-mode)
// ─────────────────────────────────────────────────────────

export type PermissionDecision = "allow" | "deny" | "ask";

export interface SecurityPolicy {
  allow: string[];
  deny: string[];
  ask: string[];
}

export interface RuntimeCounters {
  sandboxRuns: number;
  searchQueries: number;
  recallQueries: number;
  compactions: number;
  totalTokensCompacted: number;
}

// ─────────────────────────────────────────────────────────
// Info-screen integration
// ─────────────────────────────────────────────────────────

export interface CompactorInfoData {
  tokensSaved: { value: string; detail: string };
  costSaved: { value: string; detail: string };
  pctReduction: { value: string; detail: string };
  topTools: { value: string; detail: string };
  compactions: { value: string; detail: string };
  toolCalls: { value: string; detail: string };
}
