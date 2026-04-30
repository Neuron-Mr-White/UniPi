/**
 * @pi-unipi/compactor — Shared TypeScript types
 */

import type { Message } from "@mariozechner/pi-ai";

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
  keptTokensEst: number;
}

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages"
  | "no_user_message";

export type OwnCutResult =
  | { ok: true; messages: any[]; firstKeptEntryId: string; compactAll: boolean }
  | { ok: false; reason: OwnCutCancelReason };

// ─────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────

export interface CompactorStrategyConfig {
  enabled: boolean;
  mode: string;
}

export interface CompactorConfig {
  // Compaction strategies
  sessionGoals: CompactorStrategyConfig & { mode: "full" | "brief" | "off" };
  filesAndChanges: CompactorStrategyConfig & { mode: "all" | "modified-only" | "off"; maxPerCategory: number };
  commits: CompactorStrategyConfig & { mode: "full" | "brief" | "off"; maxCommits: number };
  outstandingContext: CompactorStrategyConfig & { mode: "full" | "critical-only" | "off"; maxItems: number };
  userPreferences: CompactorStrategyConfig & { mode: "all" | "recent-only" | "off"; maxPreferences: number };
  briefTranscript: CompactorStrategyConfig & { mode: "full" | "compact" | "minimal" | "off"; userTokenLimit: number; assistantTokenLimit: number; toolCallLimit: number };
  sessionContinuity: CompactorStrategyConfig & { mode: "full" | "essential-only" | "off"; eventCategories: string[] };
  fts5Index: CompactorStrategyConfig & { mode: "auto" | "manual" | "off"; chunkSize: number; cacheTtlHours: number };
  sandboxExecution: CompactorStrategyConfig & { mode: "all" | "safe-only" | "off"; allowedLanguages: string[]; outputLimit: number };
  toolDisplay: CompactorStrategyConfig & { mode: "opencode" | "balanced" | "verbose" | "custom"; diffLayout: "auto" | "split" | "unified"; diffIndicator: "bars" | "classic" | "none"; showThinkingLabels: boolean; showUserMessageBox: boolean; showBashSpinner: boolean; showPendingPreviews: boolean };

  // Pipeline feature toggles
  pipeline: {
    // On Compaction
    ttlCache: boolean;          // 24h TTL cache for ctx_fetch_and_index
    autoInjection: boolean;     // Auto-inject behavioral state after compaction
    // On Search
    proximityReranking: boolean; // Multi-term proximity boost
    timelineSort: boolean;      // Unified search across ContentStore + SessionDB
    progressiveThrottling: boolean; // Call rate limiting for ctx_search
    // On Index
    mmapPragma: boolean;        // 256MB mmap for FTS5 performance
  };

  // Global settings
  overrideDefaultCompaction: boolean;
  debug: boolean;
  showTruncationHints: boolean;
}

export type CompactorPreset = "opencode" | "balanced" | "verbose" | "minimal" | "custom";

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
  total_chars_before: number;
  total_chars_kept: number;
  total_messages_summarized: number;
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
// Content store (from context-mode)
// ─────────────────────────────────────────────────────────

export interface IndexResult {
  sourceId: number;
  label: string;
  totalChunks: number;
  codeChunks: number;
  cacheHit?: boolean;
  cachedAt?: string;
}

export interface SearchResult {
  title: string;
  content: string;
  source: string;
  rank: number;
  contentType: "code" | "prose";
  matchLayer?: "porter" | "trigram" | "fuzzy" | "rrf" | "rrf-fuzzy";
  highlighted?: string;
}

export interface StoreStats {
  sources: number;
  chunks: number;
  codeChunks: number;
}

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
// Info-screen integration
// ─────────────────────────────────────────────────────────

export interface CompactorInfoData {
  sessionEvents: { value: string; detail: string };
  compactions: { value: string; detail: string };
  tokensSaved: { value: string; detail: string };
  compressionRatio: { value: string; detail: string };
  indexedDocs: { value: string; detail: string };
  sandboxExecutions: { value: string; detail: string };
  searchQueries: { value: string; detail: string };
}
