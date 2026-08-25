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
  "btw",
  "milestone",
  "mcp",
  "utility",
  "ask-user",
  "info",
  "web-api",
  "compact",
  "notify",
  "kanboard",
  "trajectory",
  "footer",
  "updater",
  "input-shortcuts",
  "image",
  "subagents",
  "background-tasks",
];

// ─── Package Colors ──────────────────────────────────────────────────
/** ANSI bright-color codes per package */
export const PACKAGE_COLORS: Record<string, string> = {
  workflow:  `${ESC}[91m`, // Bright Red
  ralph:     `${ESC}[33m`, // Yellow/Orange
  memory:    `${ESC}[93m`, // Bright Yellow
  btw:       `${ESC}[95m`, // Bright Magenta
  milestone: `${ESC}[32m`, // Green
  mcp:       `${ESC}[32m`, // Green
  utility:   `${ESC}[36m`, // Cyan
  "ask-user": `${ESC}[94m`, // Bright Blue
  info:      `${ESC}[35m`, // Magenta
  "web-api": `${ESC}[95m`, // Bright Magenta
  compact:   `${ESC}[37m`, // White
  notify:    `${ESC}[96m`, // Bright Cyan
  kanboard:  `${ESC}[92m`, // Bright Green
  trajectory: `${ESC}[94m`, // Bright Blue
  footer:    `${ESC}[34m`, // Blue
  updater:   `${ESC}[93m`, // Bright Yellow
  "input-shortcuts": `${ESC}[95m`, // Bright Magenta
  image:     `${ESC}[35m`, // Magenta
  subagents: `${ESC}[34m`, // Blue
  "background-tasks": `${ESC}[91m`, // Bright Red
};

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

  // ralph (3 commands)
  "unipi:ralph":          "ralph",
  "unipi:ralph-start":    "ralph",
  "unipi:ralph-stop":     "ralph",

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
  "unipi:badge-settings": "utility",
  "unipi:util-settings": "utility",

  // ask-user (1 command)
  "unipi:ask-user-settings": "ask-user",

  // subagents (3 commands)
  "unipi:subagents-fleet":  "subagents",
  "unipi:subagents-doctor": "subagents",
  "unipi:subagents-guide":  "subagents",

  // background-tasks (8 commands)
  "unipi:bg":          "background-tasks",
  "unipi:bg-clear":    "background-tasks",
  "unipi:bg-tasks":    "background-tasks",
  "unipi:bg-settings": "background-tasks",
  "unipi:bg-update":   "background-tasks",
  "unipi:tasks":       "background-tasks",
  "unipi:jobs":        "background-tasks",
  "unipi:kill":        "background-tasks",
  "unipi:logs":        "background-tasks",
  "unipi:claude-cache": "background-tasks",
  "unipi:fusion":        "background-tasks",
  "unipi:fusion-models": "background-tasks",

  // info (2 commands)
  "unipi:info":          "info",
  "unipi:info-settings": "info",

  // web-api (2 commands)
  "unipi:web-settings":    "web-api",
  "unipi:web-cache-clear": "web-api",
  "unipi:image-settings":  "image",

  // compact (9 commands)
  "unipi:lossless-compact": "compact",
  "unipi:compact":         "compact",
  "unipi:session-recall":  "compact",
  "unipi:compact-recall":  "compact",
  "unipi:compact-stats":   "compact",
  "unipi:compact-doctor":  "compact",
  "unipi:compact-settings": "compact",
  "unipi:compact-preset":  "compact",
  "unipi:compact-help":    "compact",


  // milestone (2 commands)
  "unipi:milestone-onboard": "milestone",
  "unipi:milestone-update":  "milestone",

  // notify (6 commands)
  "unipi:notify-settings":  "notify",
  "unipi:notify-set-gotify": "notify",
  "unipi:notify-set-tg":    "notify",
  "unipi:notify-set-ntfy":  "notify",
  "unipi:notify-test":      "notify",
  "unipi:notify-recap-model": "notify",
  "unipi:notify-event":     "notify",

  // kanboard (2 commands)
  "unipi:kanboard":          "kanboard",
  "unipi:kanboard-doctor":   "kanboard",

  // trajectory (1 command)
  "unipi:trajectory":        "trajectory",

  // footer (3 commands)
  "unipi:footer":            "footer",
  "unipi:footer-settings":   "footer",
  "unipi:footer-help":       "footer",

  // updater (3 commands)
  "unipi:readme":            "updater",
  "unipi:changelog":         "updater",
  "unipi:updater-settings":  "updater",

  // input-shortcuts (1 command)
  "unipi:stash-settings":   "input-shortcuts",
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

  "unipi:ralph":          "Ralph loop — start/resume/status commands",
  "unipi:ralph-start":    "Start a ralph loop for the current task",
  "unipi:ralph-stop":     "Stop the active ralph loop",

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
  "unipi:badge-settings": "Configure badge settings via TUI overlay",
  "unipi:util-settings": "Unified settings — badge + diff rendering config",
  "unipi:kanboard":        "Start the kanboard visualization server",
  "unipi:kanboard-doctor": "Diagnose and fix kanboard parser issues",
  "unipi:trajectory":      "Open/reuse trajectory; add stop/off or toggle to close it",

  "unipi:ask-user-settings": "Configure ask-user settings",

  "unipi:info":          "Show system information",
  "unipi:info-settings": "Configure info display",

  "unipi:web-settings":    "Configure web search settings",
  "unipi:web-cache-clear": "Clear web search cache",
  "unipi:image-settings":  "Configure image generation and recognition models",

  "unipi:lossless-compact": "Immediate zero-LLM compaction",
  "unipi:compact":          "(DEPRECATED) Use /unipi:lossless-compact instead",
  "unipi:session-recall":   "Search session history, including compacted-away messages",
  "unipi:compact-recall":   "(DEPRECATED) Use /unipi:session-recall instead",
  "unipi:compact-stats":    "Show compaction statistics",
  "unipi:compact-doctor":   "Diagnose compaction issues",
  "unipi:compact-settings": "Configure compaction settings",
  "unipi:compact-preset":   "Manage compaction presets",
  "unipi:compact-help":     "Show compactor command help",
  "unipi:notify-settings":  "Configure notification platforms and events",
  "unipi:notify-set-gotify": "Set up Gotify push notifications",
  "unipi:notify-set-tg":    "Set up Telegram bot notifications",
  "unipi:notify-set-ntfy":  "Set up ntfy push notifications",
  "unipi:notify-test":      "Test all enabled notification platforms",
  "unipi:notify-recap-model": "Select model for notification recaps",
  "unipi:notify-event":     "Toggle a notify event without the TUI: <event> <on|off>",

  "unipi:milestone-onboard": "Create MILESTONES.md from existing workflow docs",
  "unipi:milestone-update":  "Sync MILESTONES.md with completed work",

  "unipi:footer":            "Toggle footer or switch preset",
  "unipi:footer-settings":   "Open footer settings — toggle groups and segments",
  "unipi:footer-help":       "Show footer segment guide",

  "unipi:readme":            "Browse package README files",
  "unipi:changelog":         "Browse changelog (Keep a Changelog format)",
  "unipi:updater-settings":  "Configure updater — check interval and auto-update",

  "unipi:stash-settings":   "Open input shortcuts settings — customize keybindings",

  "unipi:bg":          "Start a shell command as a tracked background task",
  "unipi:bg-clear":    "Clear finished background task footer notices",
  "unipi:bg-tasks":    "Open the background task manager UI",
  "unipi:bg-settings": "Open background-tasks settings (master toggle, defaults)",
  "unipi:bg-update":  "Show installed background-tasks version and update instructions",
  "unipi:tasks":       "Open the background task manager UI",
  "unipi:jobs":        "List running and recent background tasks",
  "unipi:kill":        "Stop a running background task: /unipi:kill <id>",
  "unipi:logs":        "Show bounded output from a background task",
  "unipi:claude-cache": "Show or set Claude cache retention for this session",
  "unipi:fusion":        "Run the Fusion reason workflow with a prompt",
  "unipi:fusion-models": "Open the Fusion five-slot model selector",
  "unipi:subagents-fleet":  "Open the subagents fleet view",
  "unipi:subagents-doctor": "Diagnose subagents configuration",
  "unipi:subagents-guide":  "Show the subagents usage guide",
};

// ─── Package Display Names ───────────────────────────────────────────
/** Pretty names for package tags in autocomplete items */
export const PACKAGE_LABELS: Record<string, string> = {
  workflow:  "workflow",
  ralph:     "ralph",
  memory:    "memory",
  btw:       "btw",
  milestone: "milestone",
  mcp:       "mcp",
  utility:   "utility",
  "ask-user": "ask-user",
  info:      "info",
  "web-api": "web-api",
  compact:   "compact",
  notify:    "notify",
  kanboard:  "kanboard",
  trajectory: "trajectory",
  footer:    "footer",
  updater:   "updater",
  "input-shortcuts": "input-shortcuts",
  image:     "image",
  subagents: "subagents",
  "background-tasks": "background-tasks",
};
