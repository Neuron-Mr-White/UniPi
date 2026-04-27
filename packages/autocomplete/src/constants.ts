/**
 * @pi-unipi/command-enchantment — Constants
 *
 * Static mappings for the command registry, package ordering, and package colors.
 * These drive the enhanced autocomplete display for /unipi:* commands.
 */

// ─── ANSI Color Helpers ──────────────────────────────────────────────
const ESC = "\x1b";
const RESET = `${ESC}[0m`;

/** Wrap text in an ANSI color code */
export function colorize(ansiCode: string, text: string): string {
  return `${ansiCode}${text}${RESET}`;
}

// ─── Package Order ───────────────────────────────────────────────────
/** Packages sorted by display priority (top-to-bottom in autocomplete) */
export const PACKAGE_ORDER: string[] = [
  "workflow",
  "ralph",
  "memory",
  "mcp",
  "utility",
  "ask-user",
  "info",
  "web-api",
  "compact",
  "notify",
];

// ─── Package Colors ──────────────────────────────────────────────────
/** ANSI bright-color codes per package */
export const PACKAGE_COLORS: Record<string, string> = {
  workflow:  `${ESC}[91m`, // Bright Red
  ralph:     `${ESC}[33m`, // Yellow/Orange
  memory:    `${ESC}[93m`, // Bright Yellow
  mcp:       `${ESC}[32m`, // Green
  utility:   `${ESC}[36m`, // Cyan
  "ask-user": `${ESC}[94m`, // Bright Blue
  info:      `${ESC}[35m`, // Magenta
  "web-api": `${ESC}[95m`, // Bright Magenta
  compact:   `${ESC}[37m`, // White
  notify:    `${ESC}[96m`, // Bright Cyan
};

// ─── Command Registry ────────────────────────────────────────────────
/** Mapping of full command name → package name (58 verified commands) */
export const COMMAND_REGISTRY: Record<string, string> = {
  // workflow (20 commands)
  "unipi:brainstorm":     "workflow",
  "unipi:plan":           "workflow",
  "unipi:work":           "workflow",
  "unipi:review-work":    "workflow",
  "unipi:consolidate":    "workflow",
  "unipi:worktree-create": "workflow",
  "unipi:worktree-list":  "workflow",
  "unipi:worktree-merge": "workflow",
  "unipi:consultant":     "workflow",
  "unipi:quick-work":     "workflow",
  "unipi:gather-context": "workflow",
  "unipi:document":       "workflow",
  "unipi:scan-issues":    "workflow",
  "unipi:auto":           "workflow",
  "unipi:debug":          "workflow",
  "unipi:fix":            "workflow",
  "unipi:quick-fix":      "workflow",
  "unipi:research":       "workflow",
  "unipi:chore-create":   "workflow",
  "unipi:chore-execute":  "workflow",

  // ralph (2 commands)
  "unipi:ralph":          "ralph",
  "unipi:ralph-stop":     "ralph",

  // memory (7 commands)
  "unipi:memory-process":     "memory",
  "unipi:memory-search":      "memory",
  "unipi:memory-consolidate": "memory",
  "unipi:memory-forget":      "memory",
  "unipi:global-memory-search": "memory",
  "unipi:global-memory-list":   "memory",
  "unipi:memory-settings":   "memory",

  // mcp (5 commands)
  "unipi:mcp-status":   "mcp",
  "unipi:mcp-sync":     "mcp",
  "unipi:mcp-add":      "mcp",
  "unipi:mcp-settings": "mcp",
  "unipi:mcp-reload":   "mcp",

  // utility (6 commands)
  "unipi:continue": "utility",
  "unipi:reload":   "utility",
  "unipi:status":   "utility",
  "unipi:cleanup":  "utility",
  "unipi:env":      "utility",
  "unipi:doctor":   "utility",

  // ask-user (1 command)
  "unipi:ask-user-settings": "ask-user",

  // info (2 commands)
  "unipi:info":          "info",
  "unipi:info-settings": "info",

  // web-api (2 commands)
  "unipi:web-settings":    "web-api",
  "unipi:web-cache-clear": "web-api",

  // compact (9 commands)
  "unipi:compact":         "compact",
  "unipi:compact-recall":  "compact",
  "unipi:compact-stats":   "compact",
  "unipi:compact-doctor":  "compact",
  "unipi:compact-settings": "compact",
  "unipi:compact-preset":  "compact",
  "unipi:compact-index":   "compact",
  "unipi:compact-search":  "compact",
  "unipi:compact-purge":   "compact",

  // notify (4 commands)
  "unipi:notify-settings":  "notify",
  "unipi:notify-set-gotify": "notify",
  "unipi:notify-set-tg":    "notify",
  "unipi:notify-test":      "notify",
};

// ─── Description Map ─────────────────────────────────────────────────
/** Short descriptions for each command (used when base suggestions lack them) */
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  "unipi:brainstorm":     "Collaborative discovery — explore problem space",
  "unipi:plan":           "Strategic planning — tasks, dependencies",
  "unipi:work":           "Execute plan — implement tasks, test, commit",
  "unipi:review-work":    "Review work — check task completion, run lint",
  "unipi:consolidate":    "Save learnings to memory, craft skills",
  "unipi:worktree-create": "Create git worktree for parallel work",
  "unipi:worktree-list":  "List all unipi worktrees",
  "unipi:worktree-merge": "Merge worktree branches back to main",
  "unipi:consultant":     "Expert consultation — advisory analysis",
  "unipi:quick-work":     "Fast single-task execution — one shot",
  "unipi:gather-context": "Research codebase — surface patterns",
  "unipi:document":       "Generate documentation — README, API docs",
  "unipi:scan-issues":    "Deep investigation — find bugs, issues",
  "unipi:auto":           "Full pipeline — brainstorm → plan → work → review",
  "unipi:debug":          "Active bug investigation — reproduce, diagnose",
  "unipi:fix":            "Fix bugs using debug reports",
  "unipi:quick-fix":      "Fast bug fix without debug report",
  "unipi:research":       "Read-only research with bash access",
  "unipi:chore-create":   "Create reusable chore definition",
  "unipi:chore-execute":  "Execute a saved chore",

  "unipi:ralph":          "Ralph loop — start/resume coding session",
  "unipi:ralph-stop":     "Stop the active ralph loop",

  "unipi:memory-process":     "Process and store conversation learnings",
  "unipi:memory-search":      "Search project memory for past context",
  "unipi:memory-consolidate": "Consolidate memory entries",
  "unipi:memory-forget":      "Remove memory entries",
  "unipi:global-memory-search": "Search across all project memories",
  "unipi:global-memory-list":   "List all project memories",
  "unipi:memory-settings":   "Configure memory settings",

  "unipi:mcp-status":   "Show MCP server status",
  "unipi:mcp-sync":     "Sync MCP server connections",
  "unipi:mcp-add":      "Add a new MCP server",
  "unipi:mcp-settings": "Configure MCP settings",
  "unipi:mcp-reload":   "Reload MCP connections",

  "unipi:continue": "Continue the last conversation",
  "unipi:reload":   "Reload extensions and settings",
  "unipi:status":   "Show system status",
  "unipi:cleanup":  "Clean up old sessions and cache",
  "unipi:env":      "Show environment info",
  "unipi:doctor":   "Run diagnostics",

  "unipi:ask-user-settings": "Configure ask-user settings",

  "unipi:info":          "Show system information",
  "unipi:info-settings": "Configure info display",

  "unipi:web-settings":    "Configure web search settings",
  "unipi:web-cache-clear": "Clear web search cache",

  "unipi:compact":          "Compact context window",
  "unipi:compact-recall":   "Recall a compacted session",
  "unipi:compact-stats":    "Show compaction statistics",
  "unipi:compact-doctor":   "Diagnose compaction issues",
  "unipi:compact-settings": "Configure compaction settings",
  "unipi:compact-preset":   "Manage compaction presets",
  "unipi:compact-index":    "Show compaction index",
  "unipi:compact-search":   "Search compacted sessions",
  "unipi:compact-purge":    "Purge old compacted sessions",

  "unipi:notify-settings":  "Configure notification platforms and events",
  "unipi:notify-set-gotify": "Set up Gotify push notifications",
  "unipi:notify-set-tg":    "Set up Telegram bot notifications",
  "unipi:notify-test":      "Test all enabled notification platforms",
};

// ─── Package Display Names ───────────────────────────────────────────
/** Pretty names for package tags in autocomplete items */
export const PACKAGE_LABELS: Record<string, string> = {
  workflow:  "workflow",
  ralph:     "ralph",
  memory:    "memory",
  mcp:       "mcp",
  utility:   "utility",
  "ask-user": "ask-user",
  info:      "info",
  "web-api": "web-api",
  compact:   "compact",
  notify:    "notify",
};
