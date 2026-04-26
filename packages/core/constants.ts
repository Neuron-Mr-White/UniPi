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
  MEMORY: ".unipi/memory",
  QUICK_WORK: ".unipi/quick-work",
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
