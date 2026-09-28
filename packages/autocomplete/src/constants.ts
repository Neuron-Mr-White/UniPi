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
  "skill-registry",
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
/** Mapping of full command name → package name (48 verified commands) */
export const COMMAND_REGISTRY: Record<string, string> = {
  // workflow (2 commands)
  "unipi:plan":           "workflow",
  "unipi:permission":     "workflow",

  // long-horizon (4 commands)
  "unipi:goal":           "long-horizon",
  "unipi:ralph":          "long-horizon",
  "unipi:swarm":          "long-horizon",
  "unipi:graph":          "long-horizon",

  // memory (7 commands)
  "unipi:memory":              "memory",
  "unipi:memory-process":      "memory",
  "unipi:memory-consolidate":  "memory",
  "unipi:memory-search":       "memory",
  "unipi:global-memory-search": "memory",
  "unipi:memory-forget":       "memory",
  "unipi:global-memory-list":  "memory",

  // btw
  "unipi:btw":           "btw",

  // subagents
  "unipi:subagents":     "subagents",
  "unipi:agents":        "subagents",

  // mcp (5 commands)
  "unipi:mcp-status":   "mcp",

  // utility
  "unipi:continue":   "utility",
  "unipi:retry":      "utility",
  "unipi:cleanup":    "utility",
  "unipi:doctor":     "utility",
  "unipi:answer":     "utility",

  // skill-registry
  "unipi:skills":     "skill-registry",

  // ask-user (1 command)

  // utility (settings hub)
  "unipi:settings":         "utility",

  // subagents (no user commands — Devin model)

  // background-tasks (8 commands)
  "unipi:bg":          "background-tasks",
  "unipi:bg-tasks":    "background-tasks",

  // fusion (3 commands)
  "unipi:model":         "fusion",
  "unipi:fusion-stats":  "fusion",

  // info (2 commands)
  "unipi:info":          "info",

  // web-api (2 commands)

  // compact (9 commands)
  "unipi:compact-vcc":      "compact",
  "unipi:compact-jev":      "compact",
  "unipi:compact-by-llm":   "compact",
  "unipi:lossless-compact": "compact",
  "unipi:compact":         "compact",
  "unipi:session-recall":  "compact",
  "unipi:compact-recall":  "compact",
  "unipi:compact-stats":   "compact",
  "unipi:compact-doctor":  "compact",
  "unipi:compact-help":    "compact",


  // notify (6 commands)
  "unipi:notify-event":     "notify",

  // kanboard (4 commands)
  "unipi:kanboard":          "kanboard",
  "unipi:kanboard-add":      "kanboard",
  "unipi:kanboard-do":       "kanboard",
  "unipi:kanboard-autowork": "kanboard",

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
  "unipi:plan":           "Plan mode — investigate read-only, then approve a plan",
  "unipi:permission":     "Permission mode — ask · auto (jev-judged) · full",

  "unipi:goal":           "One objective until verifiably true · medium complexity · pareto cost/success",
  "unipi:ralph":          "Checklist grind over iterations · enumerable chores · low cost, solid success",
  "unipi:swarm":          "Parallel fan-out + synthesis · complex decomposable · higher cost, high coverage",
  "unipi:graph":          "Dependent multi-step work · later steps need earlier results · highest cost",

  "unipi:memory":             "Memory palace — status, migrate, recall/write toggles",
  "unipi:memory-process":     "Analyze text and store extracted memories",
  "unipi:memory-consolidate": "Consolidate the current session into memory",
  "unipi:memory-search":      "Search project memories",
  "unipi:global-memory-search": "Search memories across all projects",
  "unipi:memory-forget":      "Delete a memory by title",
  "unipi:global-memory-list": "List all memories across all projects",

  "unipi:btw":           "Ask a side question in an inline panel (read-only)",

  "unipi:subagents":     "Open the subagent panel (also ↓ from an empty input)",
  "unipi:agents":        "Manage subagent profiles — create, edit, copy, delete custom agents",

  "unipi:mcp-status":   "Show MCP server status",

  "unipi:continue":   "Continue from where the agent stopped (/unipi:retry)",
  "unipi:retry":      "Retry the last turn (alias of /unipi:continue)",
  "unipi:cleanup":    "Remove stale UniPi temp files and leftovers (preview first)",
  "unipi:doctor":     "Check UniPi's runtime: config, model cache, Decision Model, skills",
  "unipi:answer":     "Answer the last reply's questions — editor template or web form",
  "unipi:skills":     "Manage skills — on/off per project, listed or not, the skill vault",

  "unipi:kanboard":        "Kanboard — capture tasks, run them, open the board",
  "unipi:kanboard-add":    "Kanboard — capture a task into Backlog",
  "unipi:kanboard-do":     "Kanboard — let the agent work the board for a turn",
  "unipi:kanboard-autowork": "Kanboard — start or stop the queue runner",

  "unipi:settings": "Configure all unipi modules in one panel",

  "unipi:info":          "Show system information",


  "unipi:compact-vcc":      "Lossless compaction now — no model call (keep:N)",
  "unipi:compact-jev":      "Lossless compaction, pruned by jev of what is no longer in force",
  "unipi:compact-by-llm":   "Compact now with a model-written summary",
  "unipi:lossless-compact": "(DEPRECATED) Use /unipi:compact-vcc instead",
  "unipi:compact":          "(DEPRECATED) Use /unipi:compact-vcc instead",
  "unipi:session-recall":   "Search session history, including compacted-away messages",
  "unipi:compact-recall":   "(DEPRECATED) Use /unipi:session-recall instead",
  "unipi:compact-stats":    "Show this session's compaction savings",
  "unipi:compact-doctor":   "Check compaction settings",
  "unipi:compact-help":     "Show compactor command help",
  "unipi:notify-event":     "Toggle a notify event without the TUI: <event> <on|off>",

  "unipi:footer":            "Toggle footer or switch preset",
  "unipi:footer-help":       "Show footer segment guide",

  "unipi:readme":            "Browse package README files",
  "unipi:changelog":         "Browse changelog (Keep a Changelog format)",


  "unipi:bg":          "Start a shell command as a tracked background task",
  "unipi:bg-tasks":    "Open the background task manager UI",
  "unipi:model":         "Pick a model or Fusion lead+sidekick pair (Devin-style picker)",
  "unipi:fusion-stats":  "Estimated Fusion savings (sidekick tokens priced at lead rates)",
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
  "skill-registry": "skills",
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
