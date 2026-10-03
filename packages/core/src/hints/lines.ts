/**
 * Unicrab hint lines — playful but concrete hints in Unicrab's voice.
 *
 * Every command, key, tool, setting path and event named here is verified
 * against the package source. Max 100 characters per line.
 */

import { registerHints, type Hint } from "./index.js";

const isTool = (name: string) => (p: unknown) =>
  (p as { toolName?: string } | undefined)?.toolName === name;

export const HINT_LINES: readonly Hint[] = [
  // ─── command (20) ───────────────────────────────────────────────────────────
  {
    id: "cmd.settings",
    category: "command",
    text: "Scuttle over to /unipi:settings for every module's options in one unified panel.",
    when: "startup",
    teaches: "/unipi:settings",
  },
  {
    id: "cmd.hint",
    category: "command",
    text: "/unipi:hint opens the full hint browser — search, filter, and inspect every tip.",
    when: "startup",
    teaches: "/unipi:hint",
  },
  {
    id: "cmd.answer",
    category: "command",
    text: "/unipi:answer walks through questions in the last reply field-by-field or in a form.",
    when: "startup",
    teaches: "/unipi:answer",
  },
  {
    id: "cmd.doctor",
    category: "command",
    text: "Catch a pinch of trouble early: /unipi:doctor audits your unipi installation.",
    when: "startup",
    teaches: "/unipi:doctor",
  },
  {
    id: "cmd.memory",
    category: "command",
    text: "/unipi:memory opens the interactive memory panel to search and inspect saved notes.",
    when: "startup",
    teaches: "/unipi:memory",
  },
  {
    id: "cmd.global-mem",
    category: "command",
    text: "/unipi:global-memory-search searches across every project's memory drawer, not just here.",
    when: "startup",
    teaches: "/unipi:global-memory-search",
  },
  {
    id: "cmd.plan",
    category: "command",
    text: "Shell out a strategy first: /unipi:plan puts the agent into research-and-plan mode.",
    when: "startup",
    teaches: "/unipi:plan",
  },
  {
    id: "cmd.permission",
    category: "command",
    text: "/unipi:permission cycles tool authority between ask, auto, and full access modes.",
    when: "startup",
    teaches: "/unipi:permission",
  },
  {
    id: "cmd.goal",
    category: "command",
    text: "/unipi:goal sets an autonomous objective that drives big multi-turn tasks to done.",
    when: "startup",
    teaches: "/unipi:goal",
  },
  {
    id: "cmd.ralph",
    category: "command",
    text: "/unipi:ralph starts an iterative loop that works a task list until every item passes.",
    when: "startup",
    teaches: "/unipi:ralph",
  },
  {
    id: "cmd.subagents",
    category: "command",
    text: "/unipi:subagents opens the background workers panel; pressing ↓ on an empty input also opens it.",
    when: "startup",
    teaches: "/unipi:subagents",
  },
  {
    id: "cmd.agents",
    category: "command",
    text: "/unipi:agents lets you create, edit, and configure custom agent profiles.",
    when: "startup",
    teaches: "/unipi:agents",
  },
  {
    id: "cmd.bg-tasks",
    category: "command",
    text: "Keep claws free: /unipi:bg-tasks opens the dashboard for running background jobs.",
    when: "startup",
    teaches: "/unipi:bg-tasks",
  },
  {
    id: "cmd.model",
    category: "command",
    text: "/unipi:model opens the picker to select models or pair Fusion lead and sidekick.",
    when: "startup",
    teaches: "/unipi:model",
  },
  {
    id: "cmd.fusion-stats",
    category: "command",
    text: "/unipi:fusion-stats reveals how much token budget your sidekick delegation saved.",
    when: "startup",
    teaches: "/unipi:fusion-stats",
  },
  {
    id: "cmd.btw",
    category: "command",
    text: "/unipi:btw asks a fast side question in a side panel without breaking agent flow.",
    when: "startup",
    teaches: "/unipi:btw",
  },
  {
    id: "cmd.session-recall",
    category: "command",
    text: "Dive beneath the surface: /unipi:session-recall searches compacted session turns.",
    when: "startup",
    teaches: "/unipi:session-recall",
  },
  {
    id: "cmd.compact-stats",
    category: "command",
    text: "/unipi:compact-stats summarizes token savings and message pruning across compactions.",
    when: "startup",
    teaches: "/unipi:compact-stats",
  },
  {
    id: "cmd.kanboard",
    category: "command",
    text: "/unipi:kanboard open launches the task board in your browser — live as agents work it.",
    when: "startup",
    teaches: "/unipi:kanboard",
  },
  {
    id: "cmd.skills",
    category: "command",
    text: "/unipi:skills lists skills and toggles them; per-skill options live in /unipi:settings.",
    when: "startup",
    teaches: "/unipi:skills",
  },

  // ─── shortcut (10) ──────────────────────────────────────────────────────────
  {
    id: "key.alt-s",
    category: "shortcut",
    text: "Alt+S opens the shortcut overlay for fast editor actions without leaving the keyboard.",
    when: "startup",
  },
  {
    id: "key.alt-s-k",
    category: "shortcut",
    text: "Press Alt+S then K to pinch the current input and file it to your kanboard backlog.",
    when: "startup",
  },
  {
    id: "key.alt-s-a",
    category: "shortcut",
    text: "Alt+S then S stashes your draft; Alt+S then A pastes the stash back onto the end.",
    when: "startup",
  },
  {
    id: "key.alt-i",
    category: "shortcut",
    text: "Alt+I inserts a literal tab character into the editor even when Tab triggers focus.",
    when: "startup",
  },
  {
    id: "key.alt-m",
    category: "shortcut",
    text: "Alt+M quickly molts your permission mode between ask, auto, and full access.",
    when: "startup",
  },
  {
    id: "key.alt-p",
    category: "shortcut",
    text: "Alt+P toggles plan mode on and off so you can review strategies before execution.",
    when: "startup",
  },
  {
    id: "key.shift-down",
    category: "shortcut",
    text: "Shift+↓ navigates right to the background task dock below the status footer.",
    when: "startup",
  },
  {
    id: "key.ctrl-alt-c",
    category: "shortcut",
    text: "Ctrl+Alt+C sweeps finished background-task notices off the footer.",
    when: "startup",
  },
  {
    id: "key.alt-h",
    category: "shortcut",
    text: "Alt+H cycles to the next hint; Alt+Shift+H navigates back in hint history.",
    when: "startup",
  },
  {
    id: "key.user-bash",
    category: "shortcut",
    text: "!cmd runs a shell command; !!cmd runs it without adding the output to context.",
    when: { event: "user_bash" },
  },

  // ─── setting (10) ───────────────────────────────────────────────────────────
  {
    id: "set.render-style",
    category: "setting",
    text: "render.style in /unipi:settings customizes tool rows: simple, regular, or advanced.",
    when: "startup",
  },
  {
    id: "set.memory-save",
    category: "setting",
    text: "memory.saveMode in /unipi:settings chooses how memories save: side agent, reminder, or off.",
    when: "startup",
  },
  {
    id: "set.permission-mode",
    category: "setting",
    text: "permission.defaultMode in /unipi:settings sets your global starting tool policy: ask, auto, or full.",
    when: "startup",
  },
  {
    id: "set.hints-crab",
    category: "setting",
    text: "hints.crab in /unipi:settings selects mascot style: auto, image, or half-blocks.",
    when: "startup",
  },
  {
    id: "set.hints-header",
    category: "setting",
    text: "hints.header in /unipi:settings controls whether Unicrab welcomes you on startup.",
    when: "startup",
  },
  {
    id: "set.watchdog-enabled",
    category: "setting",
    text: "The watchdog is off by default — watchdog.enabled in /unipi:settings lets it judge and kill stuck calls.",
    when: "startup",
  },
  {
    id: "set.notify-platforms",
    category: "setting",
    text: "notify.defaultPlatforms in /unipi:settings picks where pings land: native, Gotify, Telegram, ntfy.",
    when: "startup",
  },
  {
    id: "set.compactor-threshold",
    category: "setting",
    text: "compactor.trigger and thresholdPercent in /unipi:settings decide when context gets tidied.",
    when: "startup",
  },
  {
    id: "set.web-cache-clear",
    category: "setting",
    text: "Web pages are cached — /unipi:settings → Web API has a cache.clear action when a page goes stale.",
    when: "startup",
  },
  {
    id: "set.long-horizon-judge",
    category: "setting",
    text: "long-horizon.judge.enabled in /unipi:settings lets the AI classify prompts into autonomous modes.",
    when: "startup",
  },

  // ─── capability (10) ────────────────────────────────────────────────────────
  {
    id: "cap.bg-run",
    category: "capability",
    text: "The agent can bg_run long builds or tests while you keep chatting unblocked.",
    when: "startup",
  },
  {
    id: "cap.run-subagent",
    category: "capability",
    text: "That subagent works in its own context — its report lands inline when it finishes.",
    when: { event: "tool_call", match: isTool("run_subagent") },
  },
  {
    id: "cap.web-tools",
    category: "capability",
    text: "Surface live reef intel: web_search and multi_web_content_read pull real-time web info.",
    when: "startup",
  },
  {
    id: "cap.ask-user",
    category: "capability",
    text: "ask_user presents structured multiple-choice questions so the agent never guesses.",
    when: { event: "unipi:ask-user:prompt" },
  },
  {
    id: "cap.notify-user",
    category: "capability",
    text: "notify_user pushes OS, Telegram, or Gotify pings when background milestones complete.",
    when: { event: "unipi:notify:sent" },
  },
  {
    id: "cap.context-budget",
    category: "capability",
    text: "Check context_budget to estimate context window usage and avoid surprise compaction.",
    when: "startup",
  },
  {
    id: "cap.memory-stored",
    category: "capability",
    text: "Memory stored! Future sessions will recall this context via memory_search.",
    when: { event: "unipi:memory:stored" },
  },
  {
    id: "cap.memory-consolidated",
    category: "capability",
    text: "Memories consolidated — background analysis organized related notes into drawers.",
    when: { event: "unipi:memory:consolidated" },
  },
  {
    id: "cap.long-bash",
    category: "capability",
    text: "Long bash command? The agent can bg_run it — the session stays responsive.",
    when: { event: "hints:long-bash" },
  },
  {
    id: "cap.remember",
    category: "capability",
    text: "Asking to remember? The agent can call memory_store so facts survive sessions.",
    when: { event: "hints:remember" },
  },
  {
    id: "cap.image-input",
    category: "capability",
    text: "Image received! The agent can examine screenshots and diagrams directly.",
    when: { event: "hints:image-input" },
  },

  // ─── explain (9, event-based) ───────────────────────────────────────────────
  {
    id: "exp.permission-ask",
    category: "explain",
    text: "Permission set to ask — every writing tool call prompts for your approval.",
    when: { event: "unipi:permission:mode:changed", match: (p: unknown) => (p as { mode?: string })?.mode === "ask" },
  },
  {
    id: "exp.permission-auto",
    category: "explain",
    text: "Permission set to auto — safe tools execute freely while risky writes ask.",
    when: { event: "unipi:permission:mode:changed", match: (p: unknown) => (p as { mode?: string })?.mode === "auto" },
  },
  {
    id: "exp.permission-full",
    category: "explain",
    text: "Permission set to full — tools run without confirmation; only explicit denies block.",
    when: { event: "unipi:permission:mode:changed", match: (p: unknown) => (p as { mode?: string })?.mode === "full" },
  },
  {
    id: "exp.lh-resolved",
    category: "explain",
    text: "Long-horizon mode active — /unipi:graph shows the plan · /unipi:regular exits.",
    when: {
      event: "unipi:long-horizon:mode:resolved",
      match: (p: unknown) => ["goal", "ralph", "swarm", "graph"].includes(String((p as { mode?: string })?.mode)),
    },
  },
  {
    id: "exp.model-select",
    category: "explain",
    text: "Model changed — Fusion pairs a lead thinker with a swift worker sidekick.",
    when: { event: "model_select" },
  },
  {
    id: "exp.mcp-started",
    category: "explain",
    text: "New tools ashore: an MCP server connected and registered its tool definitions.",
    when: { event: "unipi:mcp:server:started" },
  },
  {
    id: "exp.compactor-compacted",
    category: "explain",
    text: "Context compacted — earlier transcript turns were distilled to free up context room.",
    when: { event: "unipi:compactor:compacted" },
  },
  {
    id: "exp.session-compact",
    category: "explain",
    text: "A compaction occurred: high tide swept away old turns while keeping vital facts.",
    when: { event: "session_compact" },
  },
  {
    id: "exp.update-available",
    category: "explain",
    text: "A fresh unipi release is ready to molt — check /unipi:changelog to see new features.",
    when: { event: "unipi:update:available" },
  },

  // ─── trouble (6, event-based + cleanup) ─────────────────────────────────────
  {
    id: "trb.tool-errors",
    category: "trouble",
    text: "Tool errors encountered — /unipi:doctor checks for broken dependencies or stale paths.",
    when: { event: "hints:tool-errors" },
  },
  {
    id: "trb.compact-failed",
    category: "trouble",
    text: "Compaction hit rough waters — run /unipi:compact-doctor to check compaction settings.",
    when: { event: "session_compact_failed" },
  },
  {
    id: "trb.mcp-error",
    category: "trouble",
    text: "An MCP server ran aground — inspect server status with /unipi:mcp-status.",
    when: { event: "unipi:mcp:server:error" },
  },
  {
    id: "trb.update-error",
    category: "trouble",
    text: "Update check error — verify your network or browse /unipi:changelog directly.",
    when: { event: "unipi:update:error" },
  },
  {
    id: "trb.context-high",
    category: "trouble",
    text: "Context is past 70% — /unipi:compact-vcc compacts losslessly right now, no model call.",
    when: { event: "hints:context-high" },
  },
  {
    id: "trb.cleanup",
    category: "trouble",
    text: "/unipi:cleanup previews and removes stale temp files, orphan sessions, and leftover state.",
    when: "startup",
    teaches: "/unipi:cleanup",
  },

  // ─── whatsnew (4) ───────────────────────────────────────────────────────────
  {
    id: "new.unicrab",
    category: "whatsnew",
    text: "Meet Unicrab! Your friendly pixel mascot offering contextual hints and lore.",
    when: "startup",
    since: "3.0.0-alpha.21",
  },
  {
    id: "new.alt-h",
    category: "whatsnew",
    text: "New shortcut: press Alt+H anytime to cycle hints, or Alt+Shift+H for history.",
    when: "startup",
    since: "3.0.0-alpha.21",
  },
  {
    id: "new.hint-cmd",
    category: "whatsnew",
    text: "Browse every hint in the new interactive /unipi:hint overlay with live filtering.",
    when: "startup",
    teaches: "/unipi:hint",
    since: "3.0.0-alpha.21",
  },
  {
    id: "new.start-screen",
    category: "whatsnew",
    text: "The Unicrab startup banner greets your terminal with colorful pixel crab art.",
    when: "startup",
    since: "3.0.0-alpha.21",
  },

  // ─── workflow (8) ───────────────────────────────────────────────────────────
  {
    id: "flow.plan-to-goal",
    category: "workflow",
    text: "/unipi:plan investigates first; once you approve the plan, run /unipi:goal to execute.",
    when: "startup",
    teaches: "/unipi:plan",
  },
  {
    id: "flow.plan-active",
    category: "workflow",
    text: "Plan mode is active — the agent researches first; approve the plan file to execute.",
    when: { event: "unipi:plan:mode:changed", match: (p: unknown) => (p as { active?: boolean })?.active === true },
  },
  {
    id: "flow.kanboard-autowork",
    category: "workflow",
    text: "File tasks via Alt+S then K, then let /unipi:kanboard-autowork process the backlog queue.",
    when: "startup",
    teaches: "/unipi:kanboard-autowork",
  },
  {
    id: "flow.btw-during-run",
    category: "workflow",
    text: "Agent busy with a long task? /unipi:btw asks a side question without interrupting.",
    when: "startup",
    teaches: "/unipi:btw",
  },
  {
    id: "flow.bg-notify",
    category: "workflow",
    text: "Combine bg_run with notify_user: run tests in background and get pinged on completion.",
    when: "startup",
  },
  {
    id: "flow.memory-recall",
    category: "workflow",
    text: "Store key findings with memory_store, then query them via /unipi:global-memory-search.",
    when: "startup",
    teaches: "/unipi:global-memory-search",
  },
  {
    id: "flow.compact-recall",
    category: "workflow",
    text: "After compaction clears the tide, /unipi:session-recall recovers older turn context.",
    when: "startup",
    teaches: "/unipi:session-recall",
  },
  {
    id: "flow.long-prompt",
    category: "workflow",
    text: "Big prompt detected — consider structuring complex goals with /unipi:plan mode.",
    when: { event: "hints:long-prompt" },
  },

  // ─── lore (12) ──────────────────────────────────────────────────────────────
  {
    id: "lore.1",
    category: "lore",
    text: "Unicrab walks sideways so it can read your diffs from both ends.",
    when: "startup",
  },
  {
    id: "lore.2",
    category: "lore",
    text: "Unicrab has two claws: one for git add, one for git restore. It rarely mixes them up.",
    when: "startup",
  },
  {
    id: "lore.3",
    category: "lore",
    text: "Unicrab molts its shell every release. The changelog is where it keeps the old ones.",
    when: "startup",
  },
  {
    id: "lore.4",
    category: "lore",
    text: 'Unicrab once compacted a whole ocean into one summary. The summary said: "wet".',
    when: "startup",
  },
  {
    id: "lore.5",
    category: "lore",
    text: "Unicrab is not a lobster. Please stop asking about the butter.",
    when: "startup",
  },
  {
    id: "lore.6",
    category: "lore",
    text: "Unicrab's favourite exit code is 0. Its second favourite is also 0.",
    when: "startup",
  },
  {
    id: "lore.7",
    category: "lore",
    text: "Unicrab counted the tokens in the sea. It ran out of context halfway.",
    when: "startup",
  },
  {
    id: "lore.8",
    category: "lore",
    text: "Unicrab's eyes are two pixels wide. They have seen every one of your typos.",
    when: "startup",
  },
  {
    id: "lore.9",
    category: "lore",
    text: "Sideways is still forward if you squint. — Unicrab",
    when: "startup",
  },
  {
    id: "lore.10",
    category: "lore",
    text: "Unicrab hums while your tests run. Nobody has ever heard the tune finish.",
    when: "startup",
  },
  {
    id: "lore.11",
    category: "lore",
    text: "Unicrab keeps a pebble for every bug it pinched. The beach is getting crowded.",
    when: "startup",
  },
  {
    id: "lore.12",
    category: "lore",
    text: "Merge conflicts don't scare Unicrab. It has survived low tide.",
    when: "startup",
  },
];

registerHints(HINT_LINES);
