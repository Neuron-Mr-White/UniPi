/**
 * @pi-unipi/utility — Shared types
 *
 * Type definitions for utility modules: lifecycle, cache, analytics,
 * diagnostics, display, TUI, and tools.
 */

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Cleanup function registered with the lifecycle manager */
export type CleanupFn = () => void | Promise<void>;

/** Process lifecycle state */
export type LifecycleState = "running" | "shutting_down" | "orphaned" | "error";

/** Options for ProcessLifecycle */
export interface ProcessLifecycleOptions {
  /** Polling interval in ms for parent PID checks (default: 30000) */
  pollIntervalMs?: number;
  /** Whether to install signal handlers (default: true) */
  handleSignals?: boolean;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/** Cache entry with metadata */
export interface CacheEntry<V> {
  value: V;
  expiresAt: number;
  createdAt: number;
}

/** TTL cache backend interface */
export interface CacheBackend<K, V> {
  get(key: K): Promise<V | undefined>;
  set(key: K, value: V, ttlMs: number): Promise<void>;
  has(key: K): Promise<boolean>;
  delete(key: K): Promise<boolean>;
  cleanupExpired(): Promise<number>;
  clear(): Promise<void>;
}

/** TTL cache options */
export interface TTLCacheOptions {
  /** Use SQLite persistence (default: false) */
  persistent?: boolean;
  /** SQLite DB path (default: auto) */
  dbPath?: string;
  /** Default TTL in ms */
  defaultTtlMs?: number;
  /** Max entries in memory cache */
  maxMemoryEntries?: number;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

/** Analytics event types */
export type AnalyticsEventType =
  | "module_load"
  | "command_run"
  | "tool_call"
  | "error"
  | "compaction"
  | "search";

/** Single analytics event record */
export interface AnalyticsEvent {
  id: string;
  type: AnalyticsEventType;
  timestamp: number;
  module?: string;
  command?: string;
  tool?: string;
  durationMs?: number;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

/** Daily rollup of analytics events */
export interface AnalyticsRollup {
  date: string; // YYYY-MM-DD
  events: Record<AnalyticsEventType, number>;
  totalDurationMs: number;
  errorCount: number;
}

/** Analytics collector options */
export interface AnalyticsOptions {
  /** SQLite DB path */
  dbPath?: string;
  /** Max events before auto-rollup (default: 10000) */
  maxEvents?: number;
  /** Enable daily rollup (default: true) */
  rollupEnabled?: boolean;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** Health status for a single check */
export type HealthStatus = "healthy" | "warning" | "error" | "unknown";

/** Result of a single diagnostic check */
export interface DiagnosticCheck {
  name: string;
  module: string;
  status: HealthStatus;
  message: string;
  suggestion?: string;
  durationMs: number;
}

/** Complete diagnostics report */
export interface DiagnosticsReport {
  timestamp: number;
  overall: HealthStatus;
  checks: DiagnosticCheck[];
  summary: {
    healthy: number;
    warning: number;
    error: number;
    unknown: number;
  };
}

/** Plugin for diagnostics engine */
export interface DiagnosticPlugin {
  name: string;
  module: string;
  run(): Promise<DiagnosticCheck[]>;
}

// ─── Display ─────────────────────────────────────────────────────────────────

/** Detected terminal capabilities */
export interface TerminalCapabilities {
  /** Terminal supports basic colors */
  color: boolean;
  /** Terminal supports 256/truecolor */
  truecolor: boolean;
  /** Nerd Font detected */
  nerdFont: boolean;
  /** Unicode support level */
  unicode: "none" | "basic" | "full";
  /** Terminal width in columns */
  width: number;
  /** Terminal height in rows */
  height: number;
}

/** Width management options */
export interface WidthOptions {
  /** Truncation indicator (default: "…") */
  ellipsis?: string;
  /** Whether to break words (default: false) */
  breakWords?: boolean;
}

// ─── TUI ─────────────────────────────────────────────────────────────────────

/** Settings schema entry */
export interface SettingSchema {
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  default?: unknown;
  required?: boolean;
}

/** Settings inspector state */
export interface SettingsInspectorState {
  schemas: SettingSchema[];
  values: Record<string, unknown>;
  selectedIndex: number;
  searchQuery: string;
  editMode: boolean;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

/** Single batch command entry */
export interface BatchCommand {
  type: "command" | "tool" | "search";
  name: string;
  args?: Record<string, unknown>;
}

/** Batch execution options */
export interface BatchOptions {
  /** Fail on first error (default: true) */
  failFast?: boolean;
  /** Timeout per command in ms (default: 30000) */
  commandTimeoutMs?: number;
  /** Total timeout in ms (default: 300000) */
  totalTimeoutMs?: number;
}

/** Result of a single batch command */
export interface BatchResult {
  command: BatchCommand;
  success: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
}

/** Complete batch execution result */
export interface BatchReport {
  success: boolean;
  results: BatchResult[];
  totalDurationMs: number;
  rolledBack: boolean;
}

/** Environment info returned by ctx_env */
export interface EnvironmentInfo {
  nodeVersion: string;
  piVersion: string;
  os: string;
  platform: string;
  unipiModules: string[];
  configPaths: string[];
  extensionPaths: string[];
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/** Result of a cleanup operation */
export interface CleanupResult {
  /** What was cleaned */
  category: "db" | "temp" | "session" | "cache" | "log";
  /** Items removed */
  removed: number;
  /** Bytes freed (approximate) */
  bytesFreed: number;
  /** Paths that were cleaned */
  paths: string[];
}

/** Complete cleanup report */
export interface CleanupReport {
  timestamp: number;
  results: CleanupResult[];
  totalRemoved: number;
  totalBytesFreed: number;
}

/** Cleanup options */
export interface CleanupOptions {
  /** Max age in days for DB files (default: 14) */
  dbMaxAgeDays?: number;
  /** Max age in days for temp files (default: 7) */
  tempMaxAgeDays?: number;
  /** Max age in days for sessions (default: 30) */
  sessionMaxAgeDays?: number;
  /** Dry run — report only (default: false) */
  dryRun?: boolean;
}
