/**
 * @unipi/core — Shared constants
 */

/** Prefix for all unipi commands */
export const UNIPI_PREFIX = "unipi:" as const;

/** Ralph loop state directory */
export const RALPH_DIR = ".unipi/ralph" as const;

/** Ralph completion marker */
export const RALPH_COMPLETE_MARKER = "<promise>COMPLETE</promise>" as const;

/** Unipi settings key in pi settings.json */
export const UNIPI_SETTINGS_KEY = "unipi" as const;

/** Module names */
export const MODULES = {
  CORE: "@pi-unipi/core",
  WORKFLOW: "@pi-unipi/workflow",
  RALPH: "@pi-unipi/ralph",
  SUBAGENTS: "@pi-unipi/subagents",
  MEMORY: "@pi-unipi/memory",
  INFO_SCREEN: "@pi-unipi/info-screen",
  REGISTRY: "@pi-unipi/registry",
  MCP: "@pi-unipi/mcp",
  TASK: "@pi-unipi/task",
  WEB_API: "@pi-unipi/web-api",
  IMPECCABLE: "@pi-unipi/impeccable",
  SETTINGS: "@pi-unipi/settings",
  UTILITY: "@pi-unipi/utility",
  ASK_USER: "@pi-unipi/ask-user",
  COMPACTOR: "@pi-unipi/compactor",
  NOTIFY: "@pi-unipi/notify",
  BTW: "@pi-unipi/btw",
  MILESTONE: "@pi-unipi/milestone",
  KANBOARD: "@pi-unipi/kanboard",
} as const;

/** Workflow command names */
export const WORKFLOW_COMMANDS = {
  BRAINSTORM: "brainstorm",
  PLAN: "plan",
  WORK: "work",
  REVIEW_WORK: "review-work",
  CONSOLIDATE: "consolidate",
  WORKTREE_CREATE: "worktree-create",
  WORKTREE_LIST: "worktree-list",
  WORKTREE_MERGE: "worktree-merge",
  CONSULTANT: "consultant",
  QUICK_WORK: "quick-work",
  GATHER_CONTEXT: "gather-context",
  DOCUMENT: "document",
  SCAN_ISSUES: "scan-issues",
  AUTO: "auto",
  DEBUG: "debug",
  FIX: "fix",
  QUICK_FIX: "quick-fix",
  RESEARCH: "research",
  CHORE_CREATE: "chore-create",
  CHORE_EXECUTE: "chore-execute",
} as const;

/** Ralph command names */
export const RALPH_COMMANDS = {
  START: "ralph-start",
  STOP: "ralph-stop",
  RESUME: "ralph-resume",
  STATUS: "ralph-status",
  CANCEL: "ralph-cancel",
  ARCHIVE: "ralph-archive",
  CLEAN: "ralph-clean",
  LIST: "ralph-list",
  NUKE: "ralph-nuke",
} as const;

/** Ralph tool names */
export const RALPH_TOOLS = {
  START: "ralph_start",
  DONE: "ralph_done",
} as const;

/** Unipi directory paths */
export const UNIPI_DIRS = {
  ROOT: ".unipi",
  DOCS: ".unipi/docs",
  SPECS: ".unipi/docs/specs",
  PLANS: ".unipi/docs/plans",
  GENERATED: ".unipi/docs/generated",
  REVIEWS: ".unipi/docs/reviews",
  DEBUG: ".unipi/docs/debug",
  FIX: ".unipi/docs/fix",
  QUICK_WORK: ".unipi/docs/quick-work",
  CHORE: ".unipi/docs/chore",
  MEMORY: ".unipi/memory",
} as const;

/** Memory tool names */
export const MEMORY_TOOLS = {
  STORE: "memory_store",
  SEARCH: "memory_search",
  DELETE: "memory_delete",
  LIST: "memory_list",
  GLOBAL_SEARCH: "global_memory_search",
  GLOBAL_LIST: "global_memory_list",
} as const;

/** Memory command names */
export const MEMORY_COMMANDS = {
  PROCESS: "memory-process",
  SEARCH: "memory-search",
  CONSOLIDATE: "memory-consolidate",
  FORGET: "memory-forget",
  GLOBAL_SEARCH: "global-memory-search",
  GLOBAL_LIST: "global-memory-list",
} as const;

/** Memory directory paths */
export const MEMORY_DIRS = {
  BASE: "~/.unipi/memory",
  GLOBAL: "~/.unipi/memory/global",
} as const;

/** Memory defaults */
export const MEMORY_DEFAULTS = {
  EMBEDDING_DIM: 384,
  SEARCH_LIMIT: 10,
  SNIPPET_CHARS: 150,
} as const;

/** Memory types */
export const MEMORY_TYPES = {
  PREFERENCE: "preference",
  DECISION: "decision",
  PATTERN: "pattern",
  SUMMARY: "summary",
} as const;

/** Default ralph loop settings */
export const RALPH_DEFAULTS = {
  MAX_ITERATIONS: 50,
  ITEMS_PER_ITERATION: 0,
  REFLECT_EVERY: 0,
} as const;

/** Status icons for ralph loops */
export const RALPH_STATUS_ICONS = {
  active: "▶",
  paused: "⏸",
  completed: "✓",
} as const;

/** Utility command names */
export const UTILITY_COMMANDS = {
  CONTINUE: "continue",
  RELOAD: "reload",
  STATUS: "status",
  CLEANUP: "cleanup",
  ENV: "env",
  DOCTOR: "doctor",
  BADGE_NAME: "badge-name",
  BADGE_GEN: "badge-gen",
  BADGE_TOGGLE: "badge-toggle",
} as const;

/** Utility tool names */
export const UTILITY_TOOLS = {
  CONTINUE: "continue_task",
  BATCH: "ctx_batch",
  ENV: "ctx_env",
  SET_SESSION_NAME: "set_session_name",
} as const;

/** Badge config path */
export const BADGE_CONFIG_FILE = ".unipi/config/badge.json" as const;

/** Utility directory paths */
export const UTILITY_DIRS = {
  CACHE: "~/.unipi/cache",
  ANALYTICS: "~/.unipi/analytics",
  TEMP: "/tmp/unipi",
} as const;

/** Ask-user tool names */
export const ASK_USER_TOOLS = {
  ASK: "ask_user",
} as const;

/** MCP directory paths */
export const MCP_DIRS = {
  GLOBAL_CONFIG: "~/.unipi/config/mcp",
  PROJECT_CONFIG: ".unipi/config/mcp",
  CATALOG_CACHE: "~/.unipi/config/mcp/servers.json",
} as const;

/** MCP command names */
export const MCP_COMMANDS = {
  ADD: "mcp-add",
  SETTINGS: "mcp-settings",
  SYNC: "mcp-sync",
  STATUS: "mcp-status",
  RELOAD: "mcp-reload",
} as const;

/** MCP defaults */
export const MCP_DEFAULTS = {
  SYNC_INTERVAL_MS: 86400000,
  STARTUP_TIMEOUT_MS: 10000,
  MAX_SERVERS: 20,
  TOOL_NAME_SEPARATOR: "__",
} as const;

/** Compactor tool names */
export const COMPACTOR_TOOLS = {
  COMPACT: "compact",
  VCC_RECALL: "vcc_recall",
  CTX_EXECUTE: "ctx_execute",
  CTX_EXECUTE_FILE: "ctx_execute_file",
  CTX_BATCH_EXECUTE: "ctx_batch_execute",
  CTX_INDEX: "ctx_index",
  CTX_SEARCH: "ctx_search",
  CTX_FETCH_AND_INDEX: "ctx_fetch_and_index",
  CTX_STATS: "ctx_stats",
  CTX_DOCTOR: "ctx_doctor",
} as const;

/** Compactor command names */
export const COMPACTOR_COMMANDS = {
  COMPACT: "compact",
  COMPACT_RECALL: "compact-recall",
  COMPACT_STATS: "compact-stats",
  COMPACT_DOCTOR: "compact-doctor",
  COMPACT_SETTINGS: "compact-settings",
  COMPACT_PRESET: "compact-preset",
  COMPACT_INDEX: "compact-index",
  COMPACT_SEARCH: "compact-search",
  COMPACT_PURGE: "compact-purge",
} as const;

/** Compactor directory paths */
export const COMPACTOR_DIRS = {
  CONFIG: "~/.unipi/config/compactor",
  DB: "~/.unipi/db/compactor",
} as const;

/** Kanboard command names */
export const KANBOARD_COMMANDS = {
  KANBOARD: "kanboard",
  KANBOARD_DOCTOR: "kanboard-doctor",
} as const;

/** Kanboard directory paths */
export const KANBOARD_DIRS = {
  UI_STATIC: "ui/static",
  PID_FILE: ".unipi/kanboard.pid",
} as const;

/** Kanboard defaults */
export const KANBOARD_DEFAULTS = {
  PORT: 8165,
  MAX_PORT: 8175,
} as const;

/** Notify command names */
export const NOTIFY_COMMANDS = {
  SETTINGS: "notify-settings",
  SET_GOTIFY: "notify-set-gotify",
  SET_TG: "notify-set-tg",
  TEST: "notify-test",
} as const;

/** Notify tool names */
export const NOTIFY_TOOLS = {
  NOTIFY_USER: "notify_user",
} as const;

/** Notify directory paths */
export const NOTIFY_DIRS = {
  CONFIG: "~/.unipi/config/notify",
} as const;

/** Milestone command names */
export const MILESTONE_COMMANDS = {
  ONBOARD: "milestone-onboard",
  UPDATE: "milestone-update",
} as const;

/** Milestone directory paths */
export const MILESTONE_DIRS = {
  MILESTONES: ".unipi/docs/MILESTONES.md",
} as const;

/** Compactor defaults */
export const COMPACTOR_DEFAULTS = {
  MAX_EVENTS_PER_SESSION: 1000,
  DEDUP_WINDOW: 5,
  MAX_RESUME_BYTES: 2048,
  BRIEF_MAX_LINES: 120,
  COMPACT_BRIEF_LINES: 60,
  MINIMAL_BRIEF_LINES: 20,
  OUTPUT_CAP_MB: 100,
  DEFAULT_TIMEOUT_MS: 30000,
  SESSION_TTL_DAYS: 7,
  CACHE_TTL_HOURS: 24,
  FTS5_CHUNK_SIZE: 4096,
} as const;
