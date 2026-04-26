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
  CORE: "@unipi/core",
  WORKFLOW: "@unipi/workflow",
  RALPH: "@unipi/ralph",
  SUBAGENTS: "@unipi/subagents",
  MEMORY: "@unipi/memory",
  REGISTRY: "@unipi/registry",
  MCP: "@unipi/mcp",
  TASK: "@unipi/task",
  WEBTOOLS: "@unipi/webtools",
  INFO_SCREEN: "@unipi/info-screen",
  IMPECCABLE: "@unipi/impeccable",
  SETTINGS: "@unipi/settings",
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
