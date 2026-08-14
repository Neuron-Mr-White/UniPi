/**
 * @pi-unipi/compactor — Shared TypeScript types
 */

import type { Message } from "@earendil-works/pi-ai";

// ─────────────────────────────────────────────────────────
// Normalized blocks (from pi-vcc)
// ─────────────────────────────────────────────────────────

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

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
  transcriptEntries: TranscriptEntry[];
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "tool_error";
  text?: string;
  tool?: string;
  cmd?: string;
  ref?: string;
  count?: number;
}

export interface BriefLine {
  header: string;
  lines: string[];
}

/** Runtime stats tracked during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheBytesSaved: number;
}

// ─────────────────────────────────────────────────────────
// Compaction input / output
// ─────────────────────────────────────────────────────────

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
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
  /** @deprecated Display profiles were never connected to runtime; retained for config compatibility. */
  toolDisplay: CompactorStrategyConfig & { mode: "opencode" | "balanced" | "verbose" | "custom"; diffLayout: "auto" | "split" | "unified"; diffIndicator: "bars" | "classic" | "none"; showThinkingLabels: boolean; showUserMessageBox: boolean; showBashSpinner: boolean; showPendingPreviews: boolean };

  // Pipeline features
  pipeline: {
    /** @deprecated Reserved compatibility field; ignored by runtime. */
    ttlCache: boolean;
    autoInjection: boolean;
    /** @deprecated Reserved compatibility field; ignored by runtime. */
    proximityReranking: boolean;
    /** @deprecated Reserved compatibility field; ignored by runtime. */
    timelineSort: boolean;
    /** @deprecated Reserved compatibility field; ignored by runtime. */
    progressiveThrottling: boolean;
    /** @deprecated Reserved compatibility field; ignored by runtime. */
    mmapPragma: boolean;
    customNoisePatterns: string[];
  };

  // Auto compaction trigger
  autoCompaction: AutoCompactionConfig;

  // Global settings
  overrideDefaultCompaction: boolean;
  debug: boolean;
  /** @deprecated Truncation hints were never connected to runtime; retained for config compatibility. */
  showTruncationHints: boolean;
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

// ─────────────────────────────────────────────────────────
// Display (from pi-tool-display)
// ─────────────────────────────────────────────────────────

export type DiffLayout = "auto" | "split" | "unified";
export type DiffIndicator = "bars" | "classic" | "none";
export type OutputMode = "hidden" | "summary" | "preview" | "count";

export interface ToolDisplayConfig {
  registerToolOverrides: {
    read: boolean;
    grep: boolean;
    find: boolean;
    ls: boolean;
    bash: boolean;
    edit: boolean;
    write: boolean;
  };
  enableNativeUserMessageBox: boolean;
  readOutputMode: OutputMode;
  searchOutputMode: OutputMode;
  mcpOutputMode: OutputMode;
  previewLines: number;
  expandedPreviewMaxLines: number;
  bashOutputMode: OutputMode;
  bashCollapsedLines: number;
  diffViewMode: DiffLayout;
  diffIndicatorMode: DiffIndicator;
  diffSplitMinWidth: number;
  diffCollapsedLines: number;
  diffWordWrap: boolean;
  showTruncationHints: boolean;
  showRtkCompactionHints: boolean;
}

// ─────────────────────────────────────────────────────────
// Runtime counters (live session stats)
// ─────────────────────────────────────────────────────────

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
