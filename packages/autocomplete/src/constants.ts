/**
 * @pi-unipi/command-enchantment — Constants
 *
 * Static mappings for the command registry, package ordering, and package colors.
 * These drive the enhanced autocomplete display for /unipi:* commands.
 */

// ─── Package Colors (shared with core) ──────────────────────────────
// The color map + colorize live in core so the settings hub paints the same
// per-package identity; re-exported here to keep this module's API stable.
export { PACKAGE_COLORS, colorize } from "@pi-unipi/core";

// ─── Package Order ───────────────────────────────────────────────────
/** Packages sorted by display priority (top-to-bottom in autocomplete) */
export const PACKAGE_ORDER: string[] = [
  "workflow",
  "long-horizon",
  "memory",
  "btw",
  "mcp",
  "utility",
  "ask-user",
  "info",
  "web-api",
  "compact",
  "notify",
  "kanboard",
  "footer",
  "updater",
  "input-shortcuts",
  "image",
  "subagents",
  "background-tasks",
  "fusion",
];

// ─── Command Registry ────────────────────────────────────────────────
/** Mapping of full command name → package name (88 verified commands) */
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
  "unipi:prefix-cache":   "utility",
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

  // long-horizon (4 commands)
  "unipi:goal":           "long-horizon",
  "unipi:ralph":          "long-horizon",
  "unipi:swarm":          "long-horizon",
  "unipi:graph":          "long-horizon",

  // memory (7 commands)
  "unipi:memory-process":     "memory",
  "unipi:memory-search":      "memory",
  "unipi:memory-consolidate": "memory",
  "unipi:memory-forget":      "memory",
  "unipi:global-memory-search": "memory",
  "unipi:global-memory-list":   "memory",
  "unipi:memory-settings":   "memory",

  // btw (6 commands)
  "unipi:btw":           "btw",
  "unipi:btw-tangent":   "btw",
  "unipi:btw-new":       "btw",
  "unipi:btw-clear":     "btw",
  "unipi:btw-inject":    "btw",
  "unipi:btw-summarize": "btw",

  // mcp (5 commands)
  "unipi:mcp-status":   "mcp",
  "unipi:mcp-sync":     "mcp",
  "unipi:mcp-add":      "mcp",
  "unipi:mcp-settings": "mcp",
  "unipi:mcp-reload":   "mcp",

  // utility (11 commands)
  "unipi:continue":   "utility",
  "unipi:reload":     "utility",
  "unipi:status":     "utility",
  "unipi:cleanup":    "utility",
  "unipi:env":        "utility",
  "unipi:doctor":     "utility",
  "unipi:badge-name": "utility",
  "unipi:badge-gen":  "utility",
  "unipi:badge-toggle": "utility",

  // ask-user (1 command)

  // utility (settings hub)
  "unipi:settings":         "utility",

  // subagents (3 commands)
  "unipi:subagents-fleet":  "subagents",
  "unipi:subagents-doctor": "subagents",
  "unipi:subagents-guide":  "subagents",

  // background-tasks (8 commands)
  "unipi:bg":          "background-tasks",
  "unipi:bg-tasks":    "background-tasks",

  // fusion (3 commands)
  "unipi:model":         "fusion",
  "unipi:fusion-preset": "fusion",
  "unipi:fusion-stats":  "fusion",

  // info (2 commands)
  "unipi:info":          "info",

  // web-api (2 commands)
  "unipi:web-cache-clear": "web-api",

  // compact (9 commands)
  "unipi:lossless-compact": "compact",
  "unipi:compact":         "compact",
  "unipi:session-recall":  "compact",
  "unipi:compact-recall":  "compact",
  "unipi:compact-stats":   "compact",
  "unipi:compact-doctor":  "compact",
  "unipi:compact-preset":  "compact",
  "unipi:compact-help":    "compact",


  // notify (6 commands)
  "unipi:notify-set-gotify": "notify",
  "unipi:notify-set-tg":    "notify",
  "unipi:notify-set-ntfy":  "notify",
  "unipi:notify-test":      "notify",
  "unipi:notify-recap-model": "notify",
  "unipi:notify-event":     "notify",

  // kanboard (2 commands)
  "unipi:kanboard":          "kanboard",
  "unipi:kanboard-doctor":   "kanboard",

  // footer (3 commands)
  "unipi:footer":            "footer",
  "unipi:footer-help":       "footer",

  // updater (3 commands)
  "unipi:readme":            "updater",
  "unipi:changelog":         "updater",

  // input-shortcuts (1 command)
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
  "unipi:prefix-cache":   "Show privacy-safe provider prefix-cache diagnostics",
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

  "unipi:goal":           "One objective until verifiably true · medium complexity · pareto cost/success",
  "unipi:ralph":          "Checklist grind over iterations · enumerable chores · low cost, solid success",
  "unipi:swarm":          "Parallel fan-out + synthesis · complex decomposable · higher cost, high coverage",
  "unipi:graph":          "Dependent multi-step work · later steps need earlier results · highest cost",

  "unipi:memory-process":     "Process and store conversation learnings",
  "unipi:memory-search":      "Search project memory for past context",
  "unipi:memory-consolidate": "Consolidate memory entries",
  "unipi:memory-forget":      "Remove memory entries",
  "unipi:global-memory-search": "Search across all project memories",
  "unipi:global-memory-list":   "List all project memories",
  "unipi:memory-settings":   "Configure memory settings",

  "unipi:btw":           "Run a parallel side conversation",
  "unipi:btw-tangent":   "Start a contextless BTW tangent thread",
  "unipi:btw-new":       "Start a fresh BTW thread with session context",
  "unipi:btw-clear":     "Dismiss and clear the BTW thread",
  "unipi:btw-inject":    "Inject the BTW thread into the main agent",
  "unipi:btw-summarize": "Summarize and inject the BTW thread",

  "unipi:mcp-status":   "Show MCP server status",
  "unipi:mcp-sync":     "Sync MCP server connections",
  "unipi:mcp-add":      "Add a new MCP server",
  "unipi:mcp-settings": "Configure MCP settings",
  "unipi:mcp-reload":   "Reload MCP connections",

  "unipi:continue":   "Continue the last conversation",
  "unipi:reload":     "Reload extensions and settings",
  "unipi:status":     "Show system status",
  "unipi:cleanup":    "Clean up old sessions and cache",
  "unipi:env":        "Show environment info",
  "unipi:doctor":     "Run diagnostics",
  "unipi:badge-name": "Toggle session name badge overlay",
  "unipi:badge-gen":  "Generate session name via background agent",
  "unipi:badge-toggle": "Configure badge settings (autoGen, badgeEnabled, agentTool)",
  "unipi:kanboard":        "Start the kanboard visualization server",
  "unipi:kanboard-doctor": "Diagnose and fix kanboard parser issues",

  "unipi:settings": "Configure all unipi modules in one panel",

  "unipi:info":          "Show system information",

  "unipi:web-cache-clear": "Clear web search cache",

  "unipi:lossless-compact": "Immediate zero-LLM compaction",
  "unipi:compact":          "(DEPRECATED) Use /unipi:lossless-compact instead",
  "unipi:session-recall":   "Search session history, including compacted-away messages",
  "unipi:compact-recall":   "(DEPRECATED) Use /unipi:session-recall instead",
  "unipi:compact-stats":    "Show compaction statistics",
  "unipi:compact-doctor":   "Diagnose compaction issues",
  "unipi:compact-preset":   "Manage compaction presets",
  "unipi:compact-help":     "Show compactor command help",
  "unipi:notify-set-gotify": "Set up Gotify push notifications",
  "unipi:notify-set-tg":    "Set up Telegram bot notifications",
  "unipi:notify-set-ntfy":  "Set up ntfy push notifications",
  "unipi:notify-test":      "Test all enabled notification platforms",
  "unipi:notify-recap-model": "Select model for notification recaps",
  "unipi:notify-event":     "Toggle a notify event without the TUI: <event> <on|off>",

  "unipi:footer":            "Toggle footer or switch preset",
  "unipi:footer-help":       "Show footer segment guide",

  "unipi:readme":            "Browse package README files",
  "unipi:changelog":         "Browse changelog (Keep a Changelog format)",


  "unipi:bg":          "Start a shell command as a tracked background task",
  "unipi:bg-tasks":    "Open the background task manager UI",
  "unipi:model":         "Pick a model or Fusion lead+sidekick pair (Devin-style picker)",
  "unipi:fusion-preset": "Curate the model preset used by /unipi:model",
  "unipi:fusion-stats":  "Estimated Fusion savings (sidekick tokens priced at lead rates)",
  "unipi:subagents-fleet":  "Open the subagents fleet view",
  "unipi:subagents-doctor": "Diagnose subagents configuration",
  "unipi:subagents-guide":  "Show the subagents usage guide",
};

// ─── Package Display Names ───────────────────────────────────────────
/** Pretty names for package tags in autocomplete items */
export const PACKAGE_LABELS: Record<string, string> = {
  "long-horizon": "long-horizon",
  workflow:  "workflow",
  ralph:     "long-horizon",
  memory:    "memory",
  btw:       "btw",
  mcp:       "mcp",
  utility:   "utility",
  "ask-user": "ask-user",
  info:      "info",
  "web-api": "web-api",
  compact:   "compact",
  notify:    "notify",
  kanboard:  "kanboard",
  footer:    "footer",
  updater:   "updater",
  "input-shortcuts": "input-shortcuts",
  image:     "image",
  subagents: "subagents",
  "background-tasks": "background-tasks",
  fusion:    "fusion",
};
