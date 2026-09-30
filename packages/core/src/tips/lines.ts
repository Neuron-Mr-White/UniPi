/**
 * Tip content — one line each (≤110 chars), grouped by module.
 *
 * Every command, key, tool and setting named here was verified against the
 * package source when this file was written. Keep it honest: a wrong tip is
 * worse than no tip.
 *
 * `when`: "startup" (shown once per session, least-shown first) or
 * `{ event, match? }` — a pi core event ("tool_call", "input",
 * "session_compact", "model_select", …) or a UNIPI_EVENTS name.
 */

import { registerTips, type Tip } from "./index.js";

const t = (id: string, text: string, when: Tip["when"] = "startup", maxShows?: number): Tip => ({
  id,
  text,
  when,
  maxShows,
});

const isToolCall = (name: string) => (payload: unknown) =>
  (payload as { toolName?: string } | undefined)?.toolName === name;

const isCommandInput = (prefix: string) => (payload: unknown) =>
  String((payload as { text?: string } | undefined)?.text ?? "").startsWith(prefix);

// ─── utility ────────────────────────────────────────────────────────────────

registerTips("utility", [
  t("utility.settings-hub", "/unipi:settings is the hub — every module's options, global and project scope."),
  t("utility.answer", "/unipi:answer walks the questions in the last reply — one per field, or a browser form."),
  t("utility.render-style", "render.style in /unipi:settings reshapes tool rows — simple, regular or advanced."),
  t("utility.paste-files", "Pasted screenshots and dropped files land as real files the agent can read."),
  t("utility.doctor", "Something off? /unipi:doctor checks the unipi install; /unipi:cleanup sweeps stale state."),
]);

// ─── memory ─────────────────────────────────────────────────────────────────

registerTips("memory", [
  t("memory.search-first", "memory_search before work, memory_store after — memories persist across sessions."),
  t("memory.panel", "/unipi:memory opens the memory panel — search, list, consolidate, migrate."),
  t(
    "memory.stored",
    "Stored — memory_search will surface that in future sessions.",
    { event: "unipi:memory:stored" },
  ),
  t("memory.save-mode", "memory.saveMode in /unipi:settings picks how saving happens: side agent, reminder, or off."),
  t("memory.global", "/unipi:global-memory-search searches every project's drawer, not just this one."),
]);

// ─── workflow (plan mode + permissions) ──────────────────────────────────────

registerTips("workflow", [
  t("workflow.plan", "/unipi:plan enters plan mode — the agent researches first and you approve the plan."),
  t("workflow.permission", "/unipi:permission cycles ask → auto → full — how freely tools may write."),
  t(
    "workflow.plan-active",
    "Plan mode is on — approve the plan to run it; /unipi:plan-off leaves without running.",
    { event: "unipi:plan:mode:changed", match: (p: unknown) => (p as { active?: boolean })?.active === true },
  ),
]);

// ─── long-horizon ────────────────────────────────────────────────────────────

registerTips("long-horizon", [
  t("lh.modes", "Long-horizon modes: /unipi:goal, /unipi:ralph, /unipi:swarm, /unipi:graph — /unipi:regular exits."),
  t(
    "lh.ralph-running",
    "A ralph loop is running — /unipi:graph shows the plan; /unipi:regular returns to normal mode.",
    { event: "unipi:ralph:loop:start" },
  ),
  t("lh.goal", "/unipi:goal drives a big task to done — it plans, works the steps and reports."),
]);

// ─── subagents ───────────────────────────────────────────────────────────────

registerTips("subagents", [
  t("subagents.run", "run_subagent delegates a self-contained task — its report lands inline when it finishes."),
  t(
    "subagents.read-back",
    "A backgrounded subagent keeps working — pull its report any time with read_subagent.",
    { event: "tool_call", match: isToolCall("run_subagent") },
  ),
  t("subagents.panel", "/unipi:subagents opens the live panel — or press ↓ on an empty input."),
  t("subagents.agents", "/unipi:agents manages custom agent profiles — create, edit, copy or delete them."),
]);

// ─── background-tasks ────────────────────────────────────────────────────────

registerTips("background-tasks", [
  t("bg.run", "bg_run starts long work in the background — a notification lands when it finishes."),
  t("bg.list", "/unipi:bg-tasks opens the task manager; Shift+↓ jumps to the task dock under the footer."),
  t(
    "bg.after-bash",
    "Long-running command? The agent can bg_run it — the session stays responsive meanwhile.",
    { event: "tool_call", match: isToolCall("bash") },
    2,
  ),
]);

// ─── fusion ──────────────────────────────────────────────────────────────────

registerTips("fusion", [
  t("fusion.model-picker", "/unipi:model opens the model picker — the Fusion row shows lead + sidekick models."),
  t("fusion.space-target", "On the /unipi:model Fusion row, Space toggles whether ←/→ steers lead or sidekick effort."),
  t(
    "fusion.sidekick",
    "A detached sidekick keeps running — read_subagent pulls its report back into the session.",
    { event: "tool_call", match: isToolCall("sidekick") },
  ),
  t("fusion.stats", "/unipi:fusion-stats shows what the lead and sidekick spent — tokens and cache hits."),
]);

// ─── btw ─────────────────────────────────────────────────────────────────────

registerTips("btw", [
  t("btw.aside", "/unipi:btw asks a side question in an inline panel — read-only, never reaches the main agent."),
]);

// ─── compactor ───────────────────────────────────────────────────────────────

registerTips("compactor", [
  t(
    "compactor.recall",
    "Just compacted — /unipi:session-recall can dig back into pre-compaction context.",
    { event: "unipi:compactor:compacted" },
  ),
  t(
    "compactor.after-pi-compact",
    "That was a compaction — /unipi:compact-stats shows what the compactor has been doing.",
    { event: "session_compact" },
  ),
  t("compactor.budget", "context_budget reports how full the context window is right now."),
  t("compactor.stats", "/unipi:compact-stats and /unipi:compact-doctor cover the compactor's health."),
]);

// ─── kanboard ────────────────────────────────────────────────────────────────

registerTips("kanboard", [
  t("kanboard.open", "/unipi:kanboard open launches the task board in a browser — live as agents work it."),
  t("kanboard.add", "/unipi:kanboard-add <title> files a task straight from the session."),
  t(
    "kanboard.after-add",
    "Task filed — /unipi:kanboard open shows the board.",
    { event: "input", match: isCommandInput("/unipi:kanboard-add") },
  ),
  t("kanboard.autowork", "/unipi:kanboard-autowork lets an agent work the board's queue on its own."),
]);

// ─── mcp ─────────────────────────────────────────────────────────────────────

registerTips("mcp", [
  t("mcp.status", "/unipi:mcp-status shows which MCP servers are up and the tools they expose."),
  t(
    "mcp.up",
    "An MCP server just came up — its tools are callable as <server>__<tool>.",
    { event: "unipi:mcp:server:started" },
  ),
  t("mcp.settings", "MCP servers are managed from /unipi:settings → MCP — add, sync, reload."),
]);

// ─── notify ──────────────────────────────────────────────────────────────────

registerTips("notify", [
  t("notify.platforms", "notify_user can ping the native OS, Gotify, Telegram or ntfy — configured in /unipi:settings → Notify."),
]);

// ─── input-shortcuts ─────────────────────────────────────────────────────────

registerTips("input-shortcuts", [
  t("keys.chord", "Alt+S opens the shortcut overlay — K files the editor text as a kanboard task, and more."),
  t("keys.tab", "Alt+I inserts a literal tab; both keys rebindable under /unipi:settings → Input shortcuts."),
]);

// ─── footer ──────────────────────────────────────────────────────────────────

registerTips("footer", [
  t("footer.modes", "/unipi:footer restyles the status line; /unipi:footer-help lists what's available."),
]);

// ─── updater ─────────────────────────────────────────────────────────────────

registerTips("updater", [
  t(
    "updater.available",
    "A unipi update is available — details in the update notice; /unipi:changelog lists the changes.",
    { event: "unipi:update:available" },
  ),
  t("updater.docs", "/unipi:readme and /unipi:changelog read the docs without leaving pi."),
]);

// ─── info-screen ─────────────────────────────────────────────────────────────

registerTips("info-screen", [
  t("info.dash", "/unipi:info is the dashboard — sessions, memory, MCP and cost in one screen."),
]);

// ─── skill-registry ──────────────────────────────────────────────────────────

registerTips("skill-registry", [
  t("skills.list", "/unipi:skills lists skills and toggles them; per-skill options live in /unipi:settings."),
]);

// ─── web-api ─────────────────────────────────────────────────────────────────

registerTips("web-api", [
  t("web.tools", "web_search, multi_web_content_read and web_llm_summarize give the agent the live web."),
  t("web.cache", "Web responses are cached — /unipi:settings → Web API has a cache-clear action."),
]);

// ─── ask-user ────────────────────────────────────────────────────────────────

registerTips("ask-user", [
  t("askuser.dialog", "ask_user asks you a quick multiple-choice question — the agent stays unblocked."),
  t(
    "askuser.options",
    "Tip: ask_user questions can be multi-select, and Other always takes free text.",
    { event: "unipi:ask-user:prompt" },
  ),
]);

// ─── watchdog ────────────────────────────────────────────────────────────────

registerTips("watchdog", [
  t("watchdog.off-by-default", "The watchdog is off by default — /unipi:settings → Watchdog lets it judge and kill stuck calls."),
]);

// ─── command-enchantment (autocomplete) ──────────────────────────────────────

registerTips("command-enchantment", [
  t("autocomplete.groups", "Type /unipi: and the palette groups commands by package with short labels."),
]);
