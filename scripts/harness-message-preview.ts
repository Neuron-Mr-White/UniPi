#!/usr/bin/env -S npx tsx
// UNI-49 DESIGN PREVIEW — harness-origin user-content distinction (standalone, deterministic).
//
// Shows how harness-generated messages that ARRIVE AS USER CONTENT (Ralph/progress
// guard/kanboard/memory/plan/watchdog/…) WOULD be distinguished from human-typed
// text, in three proposed densities: simple / regular / advanced. Human text keeps
// pi's native UserMessageComponent on pi's own dark theme (installed in-memory via
// setThemeInstance — nothing else is overridden); harness panels use ONE violet
// ▏ rail (#a78bfa) on a dark-slate fill (#20222d) on every painted row, blanks
// included, with content rendered at width-2 so no words are lost. This is NOT
// the live renderer: no pi session, no LLM, no model-role or transport changes,
// no settings writes. Fixture payloads are verbatim representative texts from the
// sources named per fixture (goal + fusion prompts are imported from the pure
// source modules so drift is caught by tests); the preview header chrome is never
// injected into a payload.
//
//   npx tsx scripts/harness-message-preview.ts                 # static print: gallery + mixed, all styles
//   npx tsx scripts/harness-message-preview.ts --interactive   # TUI browser
//   npx tsx scripts/harness-message-preview.ts --help
import { Markdown, matchesKey, ProcessTerminal, TuiMainScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { paintLine } from "../packages/utility/src/render/reply-bg.ts";
import { renderHarnessMessage, installHarnessRenderers, installHarnessUserRendering, fallbackHarnessMeta, readHarnessMeta, contentText, KNOWN_CUSTOM_TYPES, type HarnessThemeCompat, type HarnessMessageMeta, type RenderStyle } from "../packages/utility/src/render/harness.ts";
import { bashNudge, EDIT_NUDGE } from "../packages/fusion/src/prompts.ts";
import { CONTINUATION_HINT, RECOVERY_FRAGMENT, renderKickoff, WRAP_UP_PROMPT } from "../packages/long-horizon/src/prompts/goal.ts";

// ── pi theme: pi's OWN dark theme, installed in-memory only ─────────────────
// Human cards render through pi's real UserMessageComponent, which reads the
// theme module's global instance. Outside a pi session nothing initializes it,
// so we load the built-in dark.json via getThemeByName("dark") and install it
// with setThemeInstance — the only override, and it IS pi's default dark theme.
// The harness violet/slate look is applied with explicit SGR + paintLine below.
const piIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const themeMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/theme/theme.js")).href)) as {
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  getMarkdownTheme(): unknown;
  getThemeByName(name: string): { fg(color: string, text: string): string; bold(text: string): string } | undefined;
  setThemeInstance(t: { fg(color: string, text: string): string; bold(text: string): string }): void;
};
const loadedDark = themeMod.getThemeByName("dark");
if (loadedDark) themeMod.setThemeInstance(loadedDark);
const uiTheme = themeMod.theme;
const markdownTheme = themeMod.getMarkdownTheme();

const userMessageMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/components/user-message.js")).href)) as {
  UserMessageComponent: new (text: string, markdownTheme?: unknown, outputPad?: number) => { render(w: number): string[] };
};

// ── harness palette: ONE violet ▏ rail on a dark-slate fill ─────────────────
const VIOLET_SGR = "\x1b[38;2;167;139;250m"; // #a78bfa
const WARN_SGR = "\x1b[38;2;251;191;36m"; // #fbbf24
const FILL_BG = "\x1b[48;2;32;34;45m"; // #20222d
const FG_RESET = "\x1b[39m";

const violet = (s: string): string => `${VIOLET_SGR}${s}${FG_RESET}`;
const warn = (s: string): string => `${WARN_SGR}${s}${FG_RESET}`;
const dim = (s: string): string => uiTheme.fg("dim", s);
const muted = (s: string): string => uiTheme.fg("muted", s);
const bold = (s: string): string => uiTheme.bold(s);

export const PREVIEW_BANNER = "DESIGN PREVIEW — no live renderer or model-role changes";
const RAIL = "▏ "; // one violet rail glyph + one space; content renders at width-2

// ── fixtures ────────────────────────────────────────────────────────────────
export type Category =
  | "harness-direct" // pi.sendUserMessage → UserMessageComponent (looks human today)
  | "harness-custom" // custom-serialized (message customType or nudge-provider context entry)
  | "hidden" // display:false — never rendered
  | "tool-annotation" // appended to a tool result — not a message card at all
  | "existing-renderer" // already has a dedicated registerMessageRenderer — ALREADY DISTINCT
  | "assistant-standin" // demo stand-in row, no live claim
  | "tool-standin" // demo tool row, not a message
  | "human"; // user-typed — must stay human

export interface Fixture {
  id: string;
  label: string; // human-friendly source label shown on the panel
  title: string;
  origin: string;
  originNote?: string;
  category: Category;
  delivery: string;
  transport: string;
  visibility: string;
  synopsis: string;
  payload: string;
  check: string;
  warning?: boolean;
  standin?: string;
  splitNote?: string;
}

const ANTI_POISON =
  "This is a temporary runtime reminder for the current Turn only, not a user preference or a durable rule; " +
  "do not save this reminder or generalize it into Memory, Skills, or other persistent instruction files.";

const KICKOFF_OBJECTIVE = "UNI-49: preview how harness-origin user-content is distinguished from human text";
const MEMORY_TITLES = [
  "kanboard_platform_bin_staging_and_pack_gotchas", "root_manifest_no_scripts_previews_git_only_packaging_gate",
  "release_3_0_0_alpha_19_prepared_inotify_gotcha", "footer_tps_anchored_output_only_redesign",
  "footer_tps_index_collision_fix", "footer_ttft_turnstart_firstword_measurement",
  "footer_rainbow_zerowidth_escape_garbling_fix", "footer_lolcat_gradient_and_restart_stats",
  "footer_glance_v3_final_layout_ledger", "footer_glance_icons_rainbow_strip_polish",
  "settings_hub_shipped_seven_modules_adopted", "settings_hub_round4_absorb_overlays_unified_keys",
  "jev_judge_openrouter_decisions_endpoint_wiring", "docs_convention_moved_from_unipi_docs_to_docs",
  "decision_cocoindex_module_removed_entirely", "compactor_strategy_enforcement_staged_truthful_fix",
  "compactor_inert_pipeline_flags_hidden_deprecated", "compactor_display_settings_hidden_deprecated",
  "background_tasks_bg_run_trigger_on_completion_servers", "ask_user_subagent_guard_hard_refusal",
];

const MEMORY_RECALL_PAYLOAD = [
  "## 🧠 Memory System Active",
  "",
  'You have 347 memories stored for project "unipi".',
  "**BEFORE starting work**, call `memory_search` with relevant keywords to check for existing context.",
  "",
  "Available memories:",
  ...MEMORY_TITLES.map((t) => `- ${t}`),
  "... and 327 more",
  "",
  "**AFTER completing the task**, if you learned something non-obvious,",
  "call `memory_store` to save it for future sessions.",
  "",
  "Guardrails: read max 10 memory results per search. Update existing memories instead of creating duplicates.",
].join("\n");

export const FIXTURES: Fixture[] = [
  {
    id: "runaway-guard",
    label: "Progress guard",
    title: "repeated-action nudge",
    origin: "packages/long-horizon/src/engine/runaway.ts runawayNudgeText + ANTI_POISONING_SUFFIX (steer at src/runtime.ts:224)",
    category: "harness-direct",
    delivery: "steer",
    transport: 'pi.sendUserMessage(text, { deliverAs: "steer" })',
    visibility: "user-role message (direct transport)",
    synopsis: "same_error_family ×3 · turn-scoped guard · anti-poison suffix preserved",
    payload:
      "No-progress guard: The same error family has occurred 3 times. Do not retry the failing call unchanged: " +
      "read the error, change the inputs or approach, or ask for help with the specific blocker. " +
      ANTI_POISON,
    check: "The same error family has occurred 3 times",
    warning: true,
  },
  {
    id: "ralph-iteration",
    label: "Ralph",
    title: "loop iteration prompt",
    origin: "packages/long-horizon/src/engine/ralph.ts RalphLoop.buildIterationPrompt (static source excerpt — no filesystem mutation)",
    originNote: "static source excerpt; representative values; task file lives under .unipi/ralph/",
    category: "harness-custom",
    delivery: "custom (unipi:lh-continue stash)",
    transport: "nudge-provider stash → boundary custom_message entry (unipi:lh-continue; arbiter.ts:264) — not the sendMessage API",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "iteration 2/6 · 2 items · via unipi:lh-continue nudge stash",
    payload: `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: uni49-preview | Iteration 2/6
───────────────────────────────────────────────────────────────────────

## This iteration (≈2 items)

- [ ] Render width checks at 24/40/80/120
- [ ] Human marker-string fixture stays YOU

Task file: .unipi/ralph/uni49-preview.md (3/8 done)

## Instructions

1. Work the items above; update the task file as you go (\`- [x]\`)
2. Then call ralph_done — approximately 2 items per iteration
3. When EVERY item is checked and verified, call ralph_done one final time to claim completion`,
    check: "RALPH LOOP: uni49-preview | Iteration 2/6",
  },
  {
    id: "ralph-reflection",
    label: "Ralph",
    title: "reflection checkpoint",
    origin: "packages/long-horizon/src/engine/ralph.ts DEFAULT_REFLECT_INSTRUCTIONS (static source excerpt)",
    originNote: "static source excerpt; representative values",
    category: "harness-custom",
    delivery: "custom (unipi:lh-continue stash)",
    transport: "nudge-provider stash → boundary custom_message entry (unipi:lh-continue)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "🪞 reflection iteration · 5 checkpoint questions",
    payload: `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`,
    check: "REFLECTION CHECKPOINT",
  },
  {
    id: "goal-kickoff",
    label: "Goal",
    title: "goal kickoff contract",
    origin: "packages/long-horizon/src/prompts/goal.ts renderKickoff(KICKOFF_CONTRACT) — payload generated by the pure source module at load",
    originNote: "exact renderKickoff output; objective filled with the preview objective",
    category: "harness-custom",
    delivery: "custom (unipi:lh-continue stash, kickoff)",
    transport: "stash.put(message, { kickoff: true }) → boundary custom_message entry (unipi:lh-continue)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "new goal · kickoff contract · objective wrapped as data",
    payload: renderKickoff(KICKOFF_OBJECTIVE),
    check: "Continue working toward the active thread goal",
  },
  {
    id: "goal-continuation",
    label: "Goal",
    title: "continuation hint",
    origin: "packages/long-horizon/src/prompts/goal.ts CONTINUATION_HINT + renderContinuationHint suffix format",
    originNote: "exact CONTINUATION_HINT constant + exact renderContinuationHint line format (representative goal state)",
    category: "harness-custom",
    delivery: "custom (unipi:lh-continue stash)",
    transport: "stash → boundary custom_message entry (unipi:lh-continue)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "turn 3/12 · verifier kept the goal open",
    payload:
      `${CONTINUATION_HINT}` +
      "\nEvaluation: completion unproven — the preview artifact is not yet verified on coffee." +
      '\nGoal: "Preview harness-origin user-content distinction" (turn 3/12, 0/200000 tok)',
    check: 'Goal: "Preview harness-origin user-content distinction" (turn 3/12, 0/200000 tok',
  },
  {
    id: "goal-recovery",
    label: "Goal",
    title: "recovery after interrupted turn",
    origin: "packages/long-horizon/src/prompts/goal.ts RECOVERY_FRAGMENT",
    originNote: "exact RECOVERY_FRAGMENT constant",
    category: "harness-custom",
    delivery: "custom (unipi:lh-continue stash)",
    transport: "stash → boundary custom_message entry (unipi:lh-continue)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "resuming after interrupted/retracted turn",
    payload: RECOVERY_FRAGMENT,
    check: "Goal recovery: this goal is resuming",
  },
  {
    id: "lh-resume",
    label: "Long-horizon",
    title: "owner resume notice",
    origin: "packages/long-horizon/src/commands.ts:250 (fixed text)",
    category: "harness-direct",
    delivery: "direct",
    transport: "pi.sendUserMessage(text)",
    visibility: "user-role message (direct transport)",
    synopsis: "resumed owner · fixed continuation text",
    payload: "Continue the resumed owner from its own durable state; re-read its status before acting.",
    check: "Continue the resumed owner from its own durable state",
  },
  {
    id: "lh-budget-wrapup",
    label: "Long-horizon",
    title: "budget wrap-up",
    origin: "packages/long-horizon/src/prompts/goal.ts WRAP_UP_PROMPT",
    originNote: "exact WRAP_UP_PROMPT constant",
    category: "harness-custom",
    delivery: "custom (unipi:lh-continue stash)",
    transport: "stash → boundary custom_message entry (unipi:lh-continue)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "budget limit reached · loop stopped",
    payload: WRAP_UP_PROMPT,
    check: "reached a budget limit and the loop has stopped",
  },
  {
    id: "kanboard-do",
    label: "Kanboard",
    title: "task budget grant",
    origin: "packages/kanboard/src/commands.ts doText (static exact template; imports register settings so not imported here)",
    originNote: "static source excerpt; representative values",
    category: "harness-direct",
    delivery: "direct / followUp",
    transport: "pi.sendUserMessage (packages/kanboard/src/commands.ts:1426,1462)",
    visibility: "user-role message (direct transport)",
    synopsis: "project unipi · 5 slots · 10 writes · USER REQUEST data appended after “Request:”",
    splitNote: 'USER REQUEST data: everything after the "Request:" line (verbatim payload — the transport does not re-label it)',
    payload:
      "[kanboard] For this request you may use the kanboard skill on project unipi (CLI: `unipi-kanboard --actor agent --project unipi …`). " +
      "Budget this session: 5 task slots — each `start` uses one — and 10 board writes (add, edit, link, order, move backlog↔todo, note on tasks you don't hold); " +
      "/unipi:kanboard-do tops both back up. Always free: reads, and `finish`, `move <ID> blocked --comment`, `note` and `attach` on tasks you started. " +
      "Work the tasks yourself in this session, in whatever mode fits: `start <ID>` right before you work it, then `finish <ID> --comment \"<summary>\"` or " +
      "`move <ID> blocked --comment \"<what you need>\"` — never leave a task you started In Progress. Before starting anything, count the tasks this request needs; " +
      "if that is more than 5, start nothing — tell me you can do 5 now and ask whether to raise the limit (setting kanboard.doTasks) or work in batches. " +
      "Read a task with `show <ID>` before editing or starting it — `list` only shows titles and a one-line excerpt. " +
      "Sidekicks and subagents can read the board but not write it: brief them with the task, then update the board yourself from their report. " +
      "If the request is unclear, ask me instead of guessing.\n\nRequest: Fix the footer TPS counter — it shows 0 on the first turn after a restart.",
    check: "Budget this session: 5 task slots",
  },
  {
    id: "kanboard-claim",
    label: "Kanboard",
    title: "claim nudge (still In Progress)",
    origin: "packages/kanboard/src/monitor.ts:242-247 CLAIMS_NUDGE_CUSTOM_TYPE unipi:kanboard-continue (cap MAX_NUDGES_PER_TASK=5)",
    originNote: "static source excerpt; representative values",
    category: "harness-custom",
    delivery: "custom (unipi:kanboard-continue)",
    transport: "nudge provider → boundary custom_message entry (unipi:kanboard-continue; not the sendMessage API)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "UNI-12 still In Progress · nudge 1/5 · anti-poison suffix",
    payload:
      "↻ UNI-12 still In Progress — continue, or finish/block it (1/5)\n" +
      '`unipi-kanboard finish UNI-12 --comment "<summary>"` / `unipi-kanboard move UNI-12 blocked --comment "<what you need>"` ' +
      ANTI_POISON,
    check: "still In Progress — continue, or finish/block it (1/5)",
    warning: true,
  },
  {
    id: "kanboard-next",
    label: "Kanboard",
    title: "next-task nudge",
    origin: "packages/kanboard/src/monitor.ts:292-299 AUTOWORK_NUDGE_CUSTOM_TYPE unipi:kanboard-next",
    originNote: "static source excerpt; representative values",
    category: "harness-custom",
    delivery: "custom (unipi:kanboard-next)",
    transport: "nudge provider → boundary custom_message entry (unipi:kanboard-next; not the sendMessage API)",
    visibility: "user-role content (custom-serialized entry)",
    synopsis: "next ready task offer · anti-poison suffix",
    payload:
      "↻ next ready: UNI-14 Add retry helper — show it, start it, work it (autowork) " + ANTI_POISON,
    check: "next ready: UNI-14 Add retry helper",
  },
  {
    id: "kanboard-autowork",
    label: "Kanboard",
    title: "autowork grant",
    origin: "packages/kanboard/src/commands.ts autoworkText (static exact template)",
    originNote: "static source excerpt; representative project",
    category: "harness-direct",
    delivery: "direct / followUp",
    transport: "pi.sendUserMessage (packages/kanboard/src/commands.ts:1462)",
    visibility: "user-role message (direct transport)",
    synopsis: "autowork mode · no budget limits · generated wrapper",
    payload:
      "[kanboard] Autowork on project unipi (CLI: `unipi-kanboard --actor agent --project unipi …`): work every ready task on the board, one at a time, " +
      "in this session — choose any mode yourself (regular, goal, ralph, swarm, graph). No budget limits. Pick with `next` or `list --ready`; for each: `show <ID>`, " +
      "`start <ID>`, work it, then `finish <ID> --comment \"<summary>\"` or `move <ID> blocked --comment \"<what you need>\"`. When you finish one, I'll offer the next ready task. " +
      "Sidekicks and subagents can read the board but not write it — update the board yourself from their reports.",
    check: "Autowork on project unipi",
  },
  {
    id: "memory-recall",
    label: "Memory",
    title: "recall reminder",
    origin: "packages/memory/index.ts buildMemoryRecallReminder → customType unipi-memory-recall-reminder (index.ts:51,180)",
    originNote: "generator-equivalent text (20 title lines for count 347); titles intentionally illustrative",
    category: "harness-custom",
    delivery: "before_agent_start (injected custom message)",
    transport: "before_agent_start return.message (customType unipi-memory-recall-reminder)",
    visibility: "user-role content (custom-serialized) · existing compact badge renderer “Memory recall”, first line only (index.ts:173-181)",
    synopsis: "347 memories · project unipi · first-line badge today",
    payload: MEMORY_RECALL_PAYLOAD,
    check: "You have 347 memories stored for project",
  },
  {
    id: "memory-retro",
    label: "Memory",
    title: "save reminder",
    origin: "packages/memory/index.ts:556-568 RETRO_CUSTOM_TYPE unipi-memory-retro-reminder",
    category: "harness-custom",
    delivery: "nextTurn",
    transport: "sendMessage customType unipi-memory-retro-reminder, { deliverAs: \"nextTurn\" }",
    visibility: "user-role content (custom-serialized) · existing compact badge renderer “Memory save?” (index.ts:173-181)",
    synopsis: "one nextTurn nudge per finished run · badge today",
    payload:
      "**🧠 Memory reminder:** If you learned something non-obvious in this task, call `memory_store` to save it as a memory " +
      "for future sessions. Update existing memories instead of creating duplicates.",
    check: "Memory reminder: If you learned something non-obvious",
  },
  {
    id: "memory-consolidation",
    label: "Memory",
    title: "consolidation wrapper",
    origin: "packages/memory/commands.ts:240-249 (/unipi:memory-consolidate generated wrapper)",
    originNote: "static source excerpt; exact wrapper text",
    category: "harness-direct",
    delivery: "followUp",
    transport: "pi.sendUserMessage(text, { deliverAs: \"followUp\" }) (commands.ts:240)",
    visibility: "user-role message (direct transport)",
    synopsis: "session consolidation request · generated wrapper",
    payload:
      "Review the current session and identify any memory-worthy items:\n- User preferences discovered\n- Project decisions made\n" +
      "- Code patterns learned\n- Important context to remember\n\nFor each item, use the memory_store tool to save it with an appropriate title and type.",
    check: "Review the current session and identify any memory-worthy items",
  },
  {
    id: "skills-revealed",
    label: "Skills",
    title: "skill reveal notice",
    origin: "packages/skill-registry/index.ts:161,216 unipi-skills-revealed (content: judge.ts revealMessage)",
    originNote: "static source excerpt; representative entries",
    category: "harness-custom",
    delivery: "next-turn (triggerTurn: false)",
    transport: "sendMessage customType unipi-skills-revealed",
    visibility: "user-role content (custom-serialized)",
    synopsis: "2 relevant skills outside the active list",
    payload:
      "Relevant skills for this request (not in your skills list):\n" +
      "- memory — Persistent cross-session memory on a shared MemPalace palace. (~/unipi/packages/memory/skills/memory/SKILL.md)\n" +
      "- subagents — Delegating work to independent subagents. (~/unipi/packages/subagents/skills/subagents/SKILL.md)\n" +
      "Read a skill's SKILL.md before using it.",
    check: "Relevant skills for this request",
  },
  {
    id: "plan-on",
    label: "Plan mode",
    title: "plan-mode instructions",
    origin: "packages/workflow/src/plan/index.ts planInstructions → customType unipi:plan-mode-message (state.ts:12, PLAN_TOOL=plan_submit)",
    originNote: "static source excerpt; representative plan path",
    category: "harness-custom",
    delivery: "custom (unipi:plan-mode-message, display: true)",
    transport: "sendMessage customType PLAN_MESSAGE_TYPE (index.ts:153,181,335)",
    visibility: "user-role content (custom-serialized) · hidden per-turn reminder variant is NOT live-visible",
    synopsis: "plan mode ON · investigation only · plan file proposal.md",
    payload:
      "Plan mode is ON — investigation only, no implementation.\n" +
      "The ONLY file you may write or edit is .unipi/plan/proposal.md.\n" +
      "Bash is limited to read-only commands; every mutating tool is refused.\n" +
      "Investigate the codebase, then write the plan to that file using these\nheadings verbatim, in this order:\n" +
      "## Summary\n## Steps\n## Files\n## Risks\n## Verification\n" +
      "## Summary comes first and is written for the human approving the plan:\n" +
      "5–10 lines of plain language covering what will change and why, what the\nuser will notice, and any risks or decisions that need them — no file\npaths or code unless essential. Everything below it is the full plan for\nwhoever implements it.\n" +
      "When the plan is written, call plan_submit to ask for approval.",
    check: "When the plan is written, call plan_submit",
  },
  {
    id: "plan-approval",
    label: "Plan mode",
    title: "approved-plan implementation handoff",
    origin: "packages/workflow/src/plan/index.ts:100-105 approvePlan",
    originNote: "static source excerpt; representative plan body",
    category: "harness-direct",
    delivery: "followUp",
    transport: "pi.sendUserMessage(text, { deliverAs: \"followUp\" })",
    visibility: "user-role message (direct transport)",
    synopsis: "plan approved · implementation handoff",
    payload:
      "Implement the approved plan below. Treat it as authoritative; do not re-plan.\n\n" +
      "## Summary\nPreview-only harness message distinction: new standalone preview, no live renderer change.\n\n" +
      "## Steps\n1. Extract fixtures 2. Render three styles 3. Verify widths",
    check: "Implement the approved plan below",
  },
  {
    id: "watchdog-abort",
    label: "Watchdog",
    title: "abort notice",
    origin: "packages/watchdog/index.ts:457-463 (quoted toolName only)",
    originNote: "static source excerpt; representative values",
    category: "harness-direct",
    delivery: "followUp",
    transport: "pi.sendUserMessage(text, { deliverAs: \"followUp\" })",
    visibility: "user-role message (direct transport)",
    synopsis: "jev judged the tool stuck · turn aborted",
    payload: '⚠ Watchdog aborted "bash": jev judged it stuck.',
    check: 'Watchdog aborted "bash"',
    warning: true,
  },
  {
    id: "watchdog-custom",
    label: "Watchdog",
    title: "drained warnings batch",
    origin: "packages/watchdog/index.ts:225-234 customType unipi-watchdog (pending warnings joined)",
    originNote: "synthetic demo output; the drained warning list is dynamic session state",
    category: "harness-custom",
    delivery: "custom (unipi-watchdog)",
    transport: "before_agent_start return.message customType unipi-watchdog, display: true",
    visibility: "user-role content (custom-serialized)",
    synopsis: "2 pending warnings drained at the context boundary",
    payload:
      "⚠ bash npm test exceeded 120s without new output (jev confidence 0.9)\n\n⚠ read src/index.ts repeated 3× with identical args (jev confidence 0.8)",
    check: "exceeded 120s without new output",
    warning: true,
  },
  {
    id: "compactor-recall",
    label: "Compactor",
    title: "session-recall results",
    origin: "packages/compactor/src/commands/index.ts:70 customType compactor-recall (content: vccRecall result.text)",
    originNote: "synthetic demo output; content is dynamic backend text (vccRecall result.text)",
    category: "harness-custom",
    delivery: "next-turn (triggerTurn: true)",
    transport: "sendMessage customType compactor-recall",
    visibility: "user-role content (custom-serialized)",
    synopsis: "1 block matched · query “kanboard write budget”",
    payload:
      'Recall — "kanboard write budget" · scope lineage · page 1\n\n' +
      "- [unipi] kanboard budgets: 5 task slots + 10 writes per kanboard-do turn; reads/finish always free …\n\n1 block matched.",
    check: 'Recall — "kanboard write budget"',
  },
  {
    id: "utility-doctor",
    label: "Utility",
    title: "doctor diagnostics response",
    origin: "packages/utility/src/commands.ts customType unipi-response (content: formatDiagnosticsReport)",
    originNote: "synthetic demo output; the diagnostics report is dynamic (formatDiagnosticsReport)",
    category: "harness-custom",
    delivery: "next-turn (command response)",
    transport: "sendMessage customType unipi-response, display: true (commands.ts:17)",
    visibility: "user-role content (custom-serialized)",
    synopsis: "/unipi:doctor · runtime diagnostics",
    payload:
      "## Unipi doctor\n\n- runtime: node 24.21.0 (mise lts)\n- settings: ~/.pi/agent/settings.json OK\n- extensions: 14 loaded, 0 failed\n- node_modules: healthy",
    check: "extensions: 14 loaded, 0 failed",
  },
  {
    id: "utility-continue",
    label: "Utility",
    title: "continue kick (empty)",
    origin: "packages/utility/src/commands.ts:31 customType unipi-continue",
    category: "hidden",
    delivery: "next-turn (triggerTurn: true)",
    transport: 'sendMessage { customType: "unipi-continue", content: "", display: false }',
    visibility: "display:false — never rendered; empty payload only triggers the turn",
    synopsis: "empty content · display:false",
    payload: "",
    check: "display:false",
  },
  {
    id: "fusion-edit-nudge",
    label: "Fusion",
    title: "delegate-instead-of-edit nudge",
    origin: "packages/fusion/src/index.ts:408 appends EDIT_NUDGE to the tool result content",
    originNote: "exact EDIT_NUDGE constant, imported from the pure source module packages/fusion/src/prompts.ts",
    category: "tool-annotation",
    delivery: "appended to tool result",
    transport: "event.content += { type: \"text\", text: EDIT_NUDGE }",
    visibility: "tool-result annotation — not a user message",
    synopsis: "appended after a direct lead edit · full <system_guidance> block",
    payload: EDIT_NUDGE,
    check: "You made a direct edit yourself instead of delegating",
    warning: true,
  },
  {
    id: "fusion-bash-nudge",
    label: "Fusion",
    title: "delegate-shell-work nudge",
    origin: "packages/fusion/src/index.ts:415 appends bashNudge(count) to the tool result content",
    originNote: "exact bashNudge(4) output, generated by the pure source module packages/fusion/src/prompts.ts",
    category: "tool-annotation",
    delivery: "appended to tool result",
    transport: "event.content += { type: \"text\", text: bashNudge(count) }",
    visibility: "tool-result annotation — not a user message",
    synopsis: "4 non-trivial shell commands since last handoff · full <system_guidance> block",
    payload: bashNudge(4),
    check: "You have run 4 non-trivial shell commands yourself",
    warning: true,
  },
  {
    id: "kanboard-r1",
    label: "Kanboard",
    title: "R1 progress reminder",
    origin: "packages/kanboard/src/reminders.ts r1Text (registered at index.ts:234-238) appended to tool results",
    originNote: "static source excerpt; representative task ids",
    category: "tool-annotation",
    delivery: "appended to tool result",
    transport: "appended to tool result content (progress tracker)",
    visibility: "tool-result annotation — not a user message",
    synopsis: "UNI-12, UNI-14 still Todo · anti-poison suffix",
    payload:
      "[kanboard] UNI-12, UNI-14 are still Todo. `unipi-kanboard start <ID>` the one you're on before changing files " +
      "(it moves it to In Progress for this session), and `finish <ID> --comment \"<summary>\"` when done. " + ANTI_POISON,
    check: "are still Todo",
    warning: true,
  },
  {
    id: "watchdog-kill",
    label: "Watchdog",
    title: "kill warning",
    origin: "packages/watchdog/index.ts:210-219 prepended to the killed tool result",
    originNote: "static source excerpt; representative values",
    category: "tool-annotation",
    delivery: "appended to tool result",
    transport: "tool result content = warning + original output, isError: true",
    visibility: "tool-result annotation — not a user message",
    synopsis: "killed after 90s · jev judged it stuck",
    payload:
      "⚠ Killed by unipi watchdog after 90s: jev judged it stuck. Do not blindly re-run; investigate or change approach.",
    check: "Killed by unipi watchdog after 90s",
    warning: true,
  },
  {
    id: "background-completion",
    label: "Background tasks",
    title: "background task completion",
    origin: "packages/background-tasks/src/tools.ts:164 pi.registerMessageRenderer<BgTaskSnapshot>",
    originNote: "synthetic demo output (stand-in card)",
    category: "existing-renderer",
    delivery: "custom (background-task-notification)",
    transport: "sendMessage customType background-task-notification",
    visibility: "existing dedicated renderer — ALREADY DISTINCT",
    synopsis: "npm test · exit 0 · 2.1s",
    payload: "✓ background task · npm test · exit 0 · 2.1s",
    check: "background task · npm test",
    standin: "existing dedicated renderer; not redesigned — shown as a stand-in card, never raw XML as a human message",
  },
  {
    id: "sidekick-completion",
    label: "Fusion sidekick",
    title: "sidekick handoff completion",
    origin: "packages/fusion/src/tools.ts:182 pi.registerMessageRenderer(\"sidekick-completion\", …)",
    originNote: "synthetic demo output (stand-in card)",
    category: "existing-renderer",
    delivery: "custom (sidekick-completion)",
    transport: "sendMessage customType sidekick-completion",
    visibility: "existing dedicated renderer — ALREADY DISTINCT",
    synopsis: "handoff report returned",
    payload: "◆ sidekick done · 6 tool calls · fixture checks passed",
    check: "sidekick done · 6 tool calls",
    standin: "existing dedicated renderer; not redesigned — shown as a stand-in card, never raw XML as a human message",
  },
  {
    id: "subagent-completion",
    label: "Subagents",
    title: "subagent completion",
    origin: "packages/subagents/src/index.ts:604 pi.registerMessageRenderer(\"subagent-completion\", …)",
    originNote: "synthetic demo output (stand-in card)",
    category: "existing-renderer",
    delivery: "custom (subagent-completion)",
    transport: "sendMessage customType subagent-completion",
    visibility: "existing dedicated renderer — ALREADY DISTINCT",
    synopsis: "explore agent returned",
    payload: "◆ subagent done · explore · report attached",
    check: "subagent done · explore",
    standin: "existing dedicated renderer; not redesigned — shown as a stand-in card, never raw XML as a human message",
  },
  {
    id: "width-stress",
    label: "Preview",
    title: "width stress (CJK + long identifier)",
    origin: "synthetic preview fixture — not a harness source text",
    originNote: "synthetic demo output — width stress fixture (CJK wrap + long identifier); explicitly not verbatim source",
    category: "harness-custom",
    delivery: "none (width stress fixture)",
    transport: "synthetic payload for layout verification",
    visibility: "gallery only — exercises wrap/fill geometry",
    synopsis: "CJK + 52-char identifier · every word must survive expansion",
    payload:
      "宽度压力测试：CJK 行与长标识符在窄面板下的换行与填充行为。UNI_HARNESS_PREVIEW_WIDTH_STRESS_IDENTIFIER_0123456789 must survive " +
      "every wrap boundary at any panel width. 界界界界界界界界界界界界 second CJK sentence ends here. tail-sentinel-END-OF-PAYLOAD",
    check: "UNI_HARNESS_PREVIEW_WIDTH_STRESS_IDENTIFIER_0123456789",
  },
  {
    id: "human-task",
    label: "You",
    title: "human request",
    origin: "user (typed)",
    category: "human",
    delivery: "—",
    transport: "pi user message → UserMessageComponent",
    visibility: "user-role message (human origin)",
    synopsis: "typed by the user",
    payload: "Please fix the footer TPS counter — it shows 0 on the first turn after a restart. Check the anchored output path first.",
    check: "Please fix the footer TPS counter",
  },
  {
    id: "human-marker-prefix",
    label: "You",
    title: "human request quoting a guard string",
    origin: "user (typed)",
    category: "human",
    delivery: "—",
    transport: "pi user message → UserMessageComponent",
    visibility: "user-role message (human origin) — identical textual prefix to a guard message must NOT reclassify it",
    synopsis: "typed by the user · quotes the guard wording",
    payload:
      "No-progress guard: I keep seeing this reminder and I think it is wrong — the test suite is genuinely slow. " +
      "Please raise the watchdog timeout instead of nudging me every turn.",
    check: "I keep seeing this reminder and I think it is wrong",
  },
];

export const FIXTURE_IDS: string[] = FIXTURES.map((f) => f.id);

// ── rendering ───────────────────────────────────────────────────────────────
export type Style = "simple" | "regular" | "advanced";
export const STYLES: Style[] = ["regular", "advanced", "simple"];

function mdLines(text: string, width: number): string[] {
  if (text.length === 0) return [];
  const comp = new Markdown(text, 0, 0, markdownTheme as never, { color: (c: string) => uiTheme.fg("text", c) });
  return comp.render(width);
}

function wrapRow(text: string, width: number): string[] {
  return text.length === 0 ? [""] : wrapTextWithAnsi(text, width);
}

function harnessLabel(f: Fixture): string {
  const glyph = f.warning ? warn("⚠") : violet("◇");
  return `${glyph} ${violet(bold("UniPi"))} ${dim(`· ${f.label} · ${f.title}`)}`;
}

function detailRows(f: Fixture, inner: number): string[] {
  const rows = [
    `${dim("id:")} ${muted(f.id)}`,
    `${dim("origin:")} ${muted(f.origin)}`,
    `${dim("transport:")} ${muted(f.transport)}`,
    `${dim("delivery:")} ${muted(f.delivery)} · ${dim("visibility:")} ${muted(f.visibility)}`,
  ];
  if (f.originNote) rows.push(`${dim("note:")} ${muted(f.originNote)}`);
  if (f.splitNote) rows.push(`${violet("split:")} ${muted(f.splitNote)}`);
  if (f.standin) rows.push(`${dim("status:")} ${muted(f.standin)}`);
  return rows.flatMap((r) => wrapRow(r, inner));
}

/** Harness panel content lines (rendered at inner width; the caller paints rail+fill). */
function harnessContent(f: Fixture, style: Style, expanded: boolean, details: boolean, inner: number): string[] {
  const out: string[] = [];
  out.push(...wrapRow(harnessLabel(f), inner));
  if (details) out.push(...detailRows(f, inner));
  const body = mdLines(f.payload, inner);
  if (style === "simple") {
    out.push(...wrapRow(f.warning ? warn(f.synopsis) : muted(f.synopsis), inner));
    if (expanded) out.push(...body); // rendered AT inner width — the rail never eats content
    else out.push(...wrapRow(dim(`e: full message (${body.length} rendered rows)`), inner));
  } else if (style === "regular") {
    if (expanded) out.push(...detailRows(f, inner));
    for (const l of body) out.push(l); // full body always visible
  } else {
    if (expanded) {
      out.push(...body);
    } else {
      for (const l of body.slice(0, 4)) out.push(l);
      if (body.length > 4) out.push(...wrapRow(dim(`e: expand full (${body.length - 4} more rendered rows)`), inner));
    }
    out.push(...wrapRow(dim(`origin: harness | model role: user | delivery: ${f.delivery}`), inner));
  }
  return out;
}

/** One fixture as a panel. Harness panels: ONE violet rail + dark-slate fill on
 * every row (blanks included), content rendered at width-2 so nothing is cut. */
export function renderPanel(f: Fixture, style: Style, expanded: boolean, details: boolean, width: number): string[] {
  if (f.category === "human") {
    const out: string[] = [];
    out.push(truncateToWidth(`${uiTheme.fg("userMessageText", "❯")} ${bold("YOU")}`, width));
    out.push(...new userMessageMod.UserMessageComponent(f.payload, markdownTheme).render(width).map((l) => l.replace(/\x1b\]133;[A-C]\x07/g, "")));
    if (style === "advanced") {
      out.push(...wrapRow(dim("origin: user | model role: user | delivery: —"), width));
    }
    return out.map((l) => truncateToWidth(l, width));
  }
  if (f.category === "assistant-standin") {
    const out: string[] = [];
    out.push(truncateToWidth(`${dim("■")} ${dim(bold("ASSISTANT"))} ${dim("· stand-in — demo text, no live claim")}`, width));
    out.push(...mdLines(f.payload, width));
    return out.map((l) => truncateToWidth(l, width));
  }
  if (f.category === "tool-standin") {
    return [
      truncateToWidth(`${dim("⏺ read package.json · 13ms")} ${dim("(demo tool stand-in — not a message)")}`, width),
      truncateToWidth(dim("  " + f.payload.split("\n")[0]!), width),
    ];
  }
  if (f.category === "tool-annotation") {
    const out: string[] = [];
    out.push(truncateToWidth(`${warn("⚠")} ${violet(bold("tool-result annotation"))} ${dim(`· ${f.label}`)} ${dim("— not a user message")}`, width));
    out.push(truncateToWidth(dim("⏺ tool result → appended:"), width));
    for (const l of wrapRow(f.payload, width)) out.push(truncateToWidth(f.warning ? warn(l) : l, width));
    for (const l of wrapRow(dim(`classification: tool-result annotation · delivery: ${f.delivery}`), width)) out.push(truncateToWidth(l, width));
    return out;
  }
  if (f.category === "hidden") {
    const out: string[] = [];
    out.push(truncateToWidth(`${dim("⌀")} ${dim(bold("hidden message"))} ${dim(`· ${f.label} · display:false · never rendered`)}`, width));
    out.push(...wrapRow(dim(f.payload.length === 0 ? "(empty content — display:false)" : f.payload), width).map((l) => truncateToWidth(dim(l), width)));
    out.push(truncateToWidth(dim("inventory only — proposed distinction does not render invisible messages"), width));
    return out;
  }
  if (f.category === "existing-renderer") {
    const out: string[] = [];
    const payloadRows = wrapRow(muted(f.payload), Math.max(8, width - 2)); // reserve the ◇ glyph columns
    out.push(truncateToWidth(`${violet("◇")} ${payloadRows.shift() ?? ""}`, width));
    for (const l of payloadRows) out.push(truncateToWidth(l, width));
    out.push(...wrapRow(dim(`status: ${f.standin}`), width).map((l) => truncateToWidth(l, width)));
    if (style === "advanced") {
      out.push(...wrapRow(dim("origin: harness | model role: user | existing dedicated renderer"), width).map((l) => truncateToWidth(l, width)));
    }
    return out;
  }

  // harness-direct / harness-custom: painted panel
  const inner = Math.max(8, width - visibleWidth(RAIL));
  return harnessContent(f, style, expanded, details, inner).map((l) => {
    const clipped = truncateToWidth(l, inner); // wrap/truncate already happened at inner; never cuts wrapped words
    return paintLine(`${VIOLET_SGR}▏${FG_RESET} ${clipped}`, width, FILL_BG);
  });
}

export interface RenderOptions { width: number; expanded?: boolean; details?: boolean }

/** The fixture gallery: every event is its own panel — unrelated sources never merge. */
export function galleryLines(style: Style, opts: RenderOptions, fixtureIds: readonly string[] = FIXTURE_IDS): string[] {
  const width = opts.width;
  const out: string[] = [];
  for (const id of fixtureIds) {
    const f = FIXTURES.find((x) => x.id === id);
    if (!f) continue;
    if (out.length > 0) out.push("");
    out.push(...renderPanel(f, style, opts.expanded === true, opts.details === true, width));
  }
  return out;
}

/** Mixed transcript (chronological); see README for the beat-by-beat mapping. */
export const MIXED_SEQUENCE: string[] = [
  "human-task",
  "@assistant-1",
  "kanboard-do",
  "@tool-demo",
  "kanboard-r1",
  "runaway-guard",
  "@assistant-2",
  "ralph-iteration",
  "kanboard-autowork",
  "memory-consolidation",
  "watchdog-custom",
  "background-completion",
  "human-marker-prefix",
];

const ASSISTANT_STANDINS: Record<string, Fixture> = {
  "@assistant-1": {
    id: "@assistant-1", label: "Assistant", title: "stand-in", origin: "demo", category: "assistant-standin",
    delivery: "—", transport: "assistant message (demo)", visibility: "stand-in", synopsis: "",
    payload: "On it — I'll grant the kanboard budget and check the anchored output path.", check: "grant the kanboard budget",
  },
  "@assistant-2": {
    id: "@assistant-2", label: "Assistant", title: "stand-in", origin: "demo", category: "assistant-standin",
    delivery: "—", transport: "assistant message (demo)", visibility: "stand-in", synopsis: "",
    payload: "The anchored path was missing a read-side fallback; the fix is in review.", check: "missing a read-side fallback",
  },
};

const TOOL_STANDIN: Fixture = {
  id: "@tool-demo", label: "Tool", title: "stand-in", origin: "demo", category: "tool-standin",
  delivery: "—", transport: "tool call (demo)", visibility: "not a message", synopsis: "",
  payload: "package.json — 22 lines read (demo)", check: "package.json",
};

function fixtureById(id: string): Fixture {
  return ASSISTANT_STANDINS[id] ?? (id === "@tool-demo" ? TOOL_STANDIN : FIXTURES.find((f) => f.id === id)!);
}

/** Mixed scenario lines; anchors mark where each event starts (for n/←→). */
export function mixedLines(style: Style, opts: RenderOptions): { lines: string[]; anchors: number[] } {
  const width = opts.width;
  const lines: string[] = [];
  const anchors: number[] = [];
  for (const id of MIXED_SEQUENCE) {
    anchors.push(lines.length);
    if (lines.length > 0) lines.push("");
    const f = fixtureById(id);
    lines.push(...renderPanel(f, style, opts.expanded === true, opts.details === true, width));
  }
  return { lines, anchors };
}

// ── production mode: the REAL shared renderer (renderHarnessMessage) ───────
// UNI-53 evidence mode: harness fixtures rendered through the same production
// panel component utility installs (custom messages + the native USER patch).
// Static print only — no live renderer is changed by running this.
/** Preview-side theme shim for the production panel (preview owns its theme). */
const previewHarnessTheme = {
  getColorMode: (): "truecolor" | "256color" => "truecolor",
  getMarkdownTheme: () => markdownTheme,
};

function harnessMetaForFixture(f: Fixture): HarnessMessageMeta {
  const delivery = (["direct", "steer", "followUp", "nextTurn", "boundary", "before_agent_start"] as const).includes(
    f.delivery as never,
  )
    ? (f.delivery as "direct" | "steer" | "followUp" | "nextTurn" | "boundary" | "before_agent_start")
    : "direct";
  return {
    version: 1,
    id: `preview-${f.id}`,
    source: f.label,
    title: f.title,
    synopsis: f.synopsis,
    delivery,
    ...(f.warning ? { severity: "warning" as const } : {}),
  };
}

function getMarkdownThemeSdk(): unknown {
  return markdownTheme;
}

/** Real HOST path: installHarnessRenderers registration + pi's REAL
 * CustomMessageComponent host wrapper + the native USER probe patch over a mock
 * transcript root. Synthetic fixtures; no session, no model, no settings writes.
 * Dispatches session_shutdown on the host pi before returning so no timers leak. */
async function hostProductionLines(customType: string, expanded: boolean, style: RenderStyle, width: number): Promise<string[]> {
  const out: string[] = [];
  const handlers: Record<string, Array<(e?: unknown, c?: unknown) => unknown>> = {};
  const renderers: Record<string, any> = {};
  // Mirror installHarnessRenderers but with the REQUESTED style (not settings).
  const fakePi: any = {
    on(name: string, fn: (e?: unknown, c?: unknown) => unknown) {
      (handlers[name] ??= []).push(fn);
      return fakePi;
    },
    registerMessageRenderer(type: string, renderer: any) {
      renderers[type] = renderer;
      return fakePi;
    },
  };
  for (const type of Object.keys(KNOWN_CUSTOM_TYPES)) {
    fakePi.registerMessageRenderer(type, (message: { content?: unknown; details?: unknown }, opts: { expanded?: boolean }, th: HarnessThemeCompat) => {
      const meta = readHarnessMeta(message.details) ?? fallbackHarnessMeta(type);
      return renderHarnessMessage(contentText(message.content), meta, { expanded: opts?.expanded === true, style }, th);
    });
  }

  const f = FIXTURES.find((x) => x.id === "memory-recall")!;
  const message: any = {
    role: "custom",
    customType,
    content: f.payload,
    display: true,
    details: { unipiHarness: harnessMetaForFixture(f) },
  };
  const renderer = renderers[customType];
  if (typeof renderer !== "function") {
    out.push(dim(`no renderer registered for ${customType}`));
    return out;
  }
  // pi's REAL CustomMessageComponent host wrapper (dynamic import, same path as
  // interactive-mode) — constructor(message, renderer, getMarkdownTheme()).
  const cmMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/components/custom-message.js")).href)) as {
    CustomMessageComponent: new (message: unknown, customRenderer: unknown, markdownTheme?: unknown, outputPad?: number) => { render(w: number): string[]; setExpanded(b: boolean): void };
  };
  const hostComponent = new cmMod.CustomMessageComponent(message, renderer, getMarkdownThemeSdk(), 1);
  hostComponent.setExpanded(expanded);
  out.push(dim(`── host CustomMessageComponent · ${customType} (real host wrapper) ──`));
  out.push(...hostComponent.render(width));
  out.push("");

  // native USER probe patch: harness vs human via the real probe mapping
  const probePi: any = { on(n: string, fn: any) { (handlers[n] ??= []).push(fn); return probePi; } };
  let widgetRender: any;
  const container: any = { children: [{ contentContainer: {}, hasToolCalls: false, updateContent() {}, render: () => [] }] };
  const tui: any = { children: [container], requestRender: () => {} };
  installHarnessUserRendering(probePi);
  for (const fn of handlers["session_start"] ?? []) fn({}, {
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {
      getLeafId: () => "leaf-1",
      buildContextEntries: () => [
        { type: "message", id: "e0", message: { role: "user", content: [{ type: "text", text: "harness body" }], unipiHarness: harnessMetaForFixture(f) } },
        { type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text: "human body" }] } },
      ],
    },
    ui: { getToolsExpanded: () => expanded, setWidget: (_n: string, render: any) => { widgetRender = render; } },
  });
  const userMessageMod = (await import(pathToFileURL(join(dirname(piIndex), "modes/interactive/components/user-message.js")).href)) as {
    UserMessageComponent: new (text: string, markdownTheme?: unknown, outputPad?: number) => { render(w: number): string[] };
  };
  container.children.push(new userMessageMod.UserMessageComponent("harness body"), new userMessageMod.UserMessageComponent("human body"));
  widgetRender?.(tui, previewHarnessTheme);
  await new Promise((r) => setTimeout(r, 20));
  out.push(dim("── native USER probe patch (after persistence tick) ──"));
  for (const c of container.children as Array<any>) {
    if (typeof c.text === "string" && typeof c.render === "function") out.push(...c.render(width));
  }

  // Dispatch session_shutdown on the host pi so no timers leak.
  for (const fn of handlers["session_shutdown"] ?? []) fn();
  return out;
}
function productionLines(style: RenderStyle, expanded: boolean, width: number): string[] {
  const out: string[] = [];
  for (const id of ["runaway-guard", "kanboard-do", "memory-recall", "human-task"]) {
    const f = FIXTURES.find((x) => x.id === id)!;
    out.push(dim(`── ${f.id} ──`));
    if (f.category === "human") {
      out.push(...renderPanel(f, style, expanded, false, width));
    } else {
      out.push(...renderHarnessMessage(f.payload, harnessMetaForFixture(f), { expanded, style }, previewHarnessTheme).render(width));
    }
    out.push("");
  }
  return out.map((l) => truncateToWidth(l, width));
}

// ── output helpers ──────────────────────────────────────────────────────────
const ANSI_ALL = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

/** Strip all ANSI (SGR + OSC wrappers), keeping link text. */
export function stripAnsi(line: string): string {
  return line
    .replace(/\x1b\]8;;[^\x1b]*\x1b\\([^\x1b]*)\x1b\]8;;\x1b\\/g, "$1")
    .replace(ANSI_ALL, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function headerRows(scenario: string, style: Style, extra: string, width: number): string[] {
  // the design-preview claim leads so it survives truncation at any width
  const head1 = `${warn(bold("DESIGN PREVIEW — no live renderer or model-role changes"))} ${violet(bold("UNI-49 HARNESS MESSAGE PREVIEW"))}`;
  const head2 = `${dim(`style ${style} · scenario ${scenario}${extra}`)}`;
  return [truncateToWidth(head1, width), truncateToWidth(head2, width)];
}

/** Static print: gallery (all fixtures) + mixed, per style. */
export function printAll(opts: { plain: boolean; styles: Style[]; scenario: "mixed" | "gallery" | "both"; fixture: string | null; width: number; expanded: boolean; production?: boolean }): string {
  const out: string[] = [];
  out.push(...headerRows(opts.scenario, opts.styles[0]!, ` · width ${opts.width} · ${opts.expanded ? "expanded" : "collapsed"}`, opts.width));
  if (opts.production) {
    out.push(dim("production renderer — renderHarnessMessage (pure panels; host wrappers printed by the runner)"));
    out.push("");
    for (const style of opts.styles) {
      out.push(dim(`── production · style ${style} ──`));
      out.push(...productionLines(style, opts.expanded, opts.width));
      out.push("");
    }
    const text = out.join("\n");
    return opts.plain ? stripAnsi(text).replace(/[ \t]+$/gm, "") : text;
  }
  out.push(dim("frozen fixtures · payloads verbatim from the cited sources (goal/fusion imported from pure modules) · violet ▏ #a78bfa + fill #20222d · human cards native dark"));
  out.push("");
  const want = (s: "mixed" | "gallery") => opts.scenario === "both" || opts.scenario === s;
  for (const style of opts.styles) {
    if (want("gallery")) {
      const ids = opts.fixture && opts.fixture !== "all" ? [opts.fixture] : FIXTURE_IDS;
      out.push(dim(`── gallery · style ${style} ──`));
      out.push(...galleryLines(style, { width: opts.width, expanded: opts.expanded }, ids));
      out.push("");
    }
    if (want("mixed")) {
      out.push(dim(`── mixed scenario · style ${style} ──`));
      out.push(...mixedLines(style, { width: opts.width, expanded: opts.expanded }).lines);
      out.push("");
    }
  }
  const text = out.join("\n");
  return opts.plain ? stripAnsi(text).replace(/[ \t]+$/gm, "") : text;
}

// ── interactive browser (state machine exported for tests) ──────────────────
export type Scenario = "mixed" | "gallery";

export interface BrowserState {
  scenario: Scenario;
  style: Style;
  fixtureIndex: number;
  expanded: boolean;
  details: boolean;
  scroll: number;
  quit: boolean;
  rows: number;
}

export function createBrowser(seed: Partial<BrowserState> = {}): BrowserState {
  return { scenario: "mixed", style: "simple", fixtureIndex: 0, expanded: false, details: false, scroll: 0, quit: false, rows: 24, ...seed };
}

function bodyFor(state: BrowserState, width: number): { lines: string[]; anchors: number[] } {
  if (state.scenario === "mixed") return mixedLines(state.style, { width, expanded: state.expanded, details: state.details });
  const id = FIXTURE_IDS[state.fixtureIndex % FIXTURE_IDS.length]!;
  return { lines: galleryLines(state.style, { width, expanded: state.expanded, details: state.details }, [id]), anchors: [0] };
}

/** Full-screen frame; exported so tests can assert rows per scenario. */
export function browserLines(state: BrowserState, width: number): string[] {
  const { lines } = bodyFor(state, width);
  const id = FIXTURE_IDS[state.fixtureIndex % FIXTURE_IDS.length]!;
  const label = FIXTURES.find((f) => f.id === id)?.label ?? id;
  const head1 = truncateToWidth(`${warn(bold(PREVIEW_BANNER))} ${violet(bold("UNI-49 HARNESS MESSAGE PREVIEW"))}`, width);
  const head2 = truncateToWidth(dim(`style ${state.style} · scenario ${state.scenario} · fixture ${id} (${label}) · ${state.expanded ? "expanded" : "collapsed"}${state.details ? " · details" : ""}`), width);
  const keys = truncateToWidth(
    width < 90
      ? dim(" 1/2/3 style · n fixture · m scene · e expand · d details · q quit")
      : dim(" 1 regular · 2 advanced · 3 simple · n/←→ fixture · m mixed/gallery · e expand · d details · ↑↓/pgup/pgdn scroll · q/esc quit"),
    width,
  );
  const viewRows = Math.max(6, state.rows - 4);
  const scrollMax = Math.max(0, lines.length - viewRows);
  const at = Math.max(0, Math.min(state.scroll, scrollMax));
  const view = lines.slice(at, at + viewRows);
  while (view.length < viewRows) view.push("");
  return [head1, head2, ...view.map((l) => truncateToWidth(l, width)), keys];
}

/** Apply one key press; returns the state (mutated in place, like the TUI). */
export function handleKey(state: BrowserState, data: string, terminalWidth = 96): BrowserState {
  const { anchors } = bodyFor(state, terminalWidth);
  if (matchesKey(data, "ctrl+c") || data === "q" || matchesKey(data, "escape")) {
    state.quit = true;
    return state;
  }
  else if (data === "1") state.style = "regular";
  else if (data === "2") state.style = "advanced";
  else if (data === "3") state.style = "simple";
  else if (data === "m") {
    state.scenario = state.scenario === "mixed" ? "gallery" : "mixed";
    state.scroll = 0; // new body — reset instead of clamping into the middle
  } else if (data === "e") state.expanded = !state.expanded;
  else if (data === "d") state.details = !state.details;
  else if (data === "n" || matchesKey(data, "right")) {
    if (state.scenario === "gallery") {
      state.fixtureIndex = (state.fixtureIndex + 1) % FIXTURE_IDS.length;
      state.scroll = 0; // fixture changed — start at its top
    } else {
      const next = anchors.find((a) => a > state.scroll + 1);
      state.scroll = next ?? anchors[0]!;
    }
  } else if (matchesKey(data, "left")) {
    if (state.scenario === "gallery") {
      state.fixtureIndex = (state.fixtureIndex - 1 + FIXTURE_IDS.length) % FIXTURE_IDS.length;
      state.scroll = 0;
    } else {
      const prev = [...anchors].reverse().find((a) => a < state.scroll - 1);
      state.scroll = prev ?? anchors[anchors.length - 1]!;
    }
  } else if (matchesKey(data, "up")) state.scroll -= 1;
  else if (matchesKey(data, "down")) state.scroll += 1;
  else if (matchesKey(data, "pageUp")) state.scroll -= 10;
  else if (matchesKey(data, "pageDown")) state.scroll += 10;
  else return state;
  // clamp AFTER mutation: style/expand/scenario/fixture changes recompute the body
  const { lines: newLines } = bodyFor(state, terminalWidth);
  const viewRows = Math.max(6, state.rows - 4);
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, newLines.length - viewRows)));
  return state;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const HELP = `UNI-49 DESIGN PREVIEW — harness-origin user-content distinction (NOT the live renderer)

Usage: npx tsx scripts/harness-message-preview.ts [flags]

  --interactive    TUI browser (keys: 1/2/3 style · n/←→ fixture · m mixed/gallery ·
                   e expand · d details · ↑↓/pgup/pgdn scroll · q/esc quit)
  --print          static output — gallery + mixed for every style (default)
  --plain          strip ANSI: plain text for files/diffs
  --style NAME     regular | advanced | simple (filter; default all)
  --fixture ID     one gallery fixture by id, or "all" (default all)
  --scenario NAME  mixed | gallery | both (default both for --print)
  --width N        print width (default 96, clamped 24–200)
  --expand         render expanded (default collapsed)
  --production     render harness fixtures through the REAL shared production
                   renderer (renderHarnessMessage) — static print evidence
  --help           this text

Interactive seeding precedence: an explicit --scenario always wins; otherwise a
specific --fixture seeds the gallery on that fixture; with neither, the browser
opens on the mixed scenario.

Frozen fixtures only — payloads are verbatim representative texts from the cited
sources (goal kickoff/continuation/recovery/wrap-up and the fusion nudges are
imported from the pure source modules and asserted by tests). No pi session, no
LLM, no model-role or transport changes, no settings writes. Human text renders
through pi's native UserMessageComponent on pi's own dark theme, installed
in-memory via setThemeInstance; harness panels are painted violet/dark-slate.`;

interface Options {
  mode: "print" | "interactive";
  plain: boolean;
  styles: Style[];
  scenario: "mixed" | "gallery" | "both";
  fixture: string | null;
  width: number;
  expanded: boolean;
  production: boolean;
}

export function parseArgs(argv: string[]): { ok: true; opts: Options } | { ok: false; message: string } {
  const opts: Options = { mode: "print", plain: false, styles: [...STYLES], scenario: "both", fixture: null, width: 96, expanded: false, production: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return { ok: false, message: `__HELP__` };
    else if (a === "--interactive") opts.mode = "interactive";
    else if (a === "--print") opts.mode = "print";
    else if (a === "--plain") opts.plain = true;
    else if (a === "--expand") opts.expanded = true;
    else if (a === "--production") opts.production = true;
    else if (a === "--style") opts.styles = [argv[++i] as Style];
    else if (a === "--fixture") opts.fixture = argv[++i] ?? "";
    else if (a === "--scenario") opts.scenario = argv[++i] as Options["scenario"];
    else if (a === "--width") opts.width = Number(argv[++i]);
    else return { ok: false, message: `unknown flag: ${a}` };
  }
  if (opts.styles.some((s) => !STYLES.includes(s))) return { ok: false, message: `--style must be one of ${STYLES.join(", ")}` };
  if (opts.fixture !== null && opts.fixture !== "all" && !FIXTURE_IDS.includes(opts.fixture)) {
    return { ok: false, message: `--fixture must be one of ${FIXTURE_IDS.join(", ")} or "all"` };
  }
  if (!["mixed", "gallery", "both"].includes(opts.scenario)) return { ok: false, message: "--scenario must be mixed | gallery | both" };
  if (!Number.isFinite(opts.width)) return { ok: false, message: "--width needs a number" };
  opts.width = Math.min(200, Math.max(24, Math.trunc(opts.width)));
  return { ok: true, opts };
}

/** Interactive seeding: explicit --scenario wins; else explicit --fixture opens
 * the gallery on it; else mixed. */
export function seedBrowser(opts: Options): BrowserState {
  const explicitMixed = opts.scenario === "mixed";
  const fixtureExplicit = opts.fixture !== null && opts.fixture !== "all";
  const scenario: Scenario = explicitMixed ? "mixed" : fixtureExplicit || opts.scenario === "gallery" ? "gallery" : "mixed";
  const fixtureIndex = fixtureExplicit && !explicitMixed ? Math.max(0, FIXTURE_IDS.indexOf(opts.fixture!)) : 0;
  return createBrowser({ scenario, style: opts.styles[0]!, expanded: opts.expanded, fixtureIndex });
}

/** CLI entry (returns the process exit code; tests call this directly). */
export function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__HELP__") {
      process.stdout.write(`${HELP}\n`);
      return 0;
    }
    process.stderr.write(`${parsed.message}\n\n${HELP}\n`);
    return 2;
  }
  const opts = parsed.opts;
  if (opts.mode === "interactive") {
    interactive(opts);
    return 0;
  }
  process.stdout.write(`${printAll(opts)}\n`);
  if (opts.production) {
    // Real host wrappers (async): printed after the static panels.
    void (async () => {
      const rows = await hostProductionLines("unipi-memory-recall-reminder", opts.expanded, opts.styles[0] ?? "simple", opts.width);
      process.stdout.write(`${rows.join("\n")}\n`);
    })();
    return 0;
  }
  return 0;
}

class Preview implements Component {
  scroll = 0;
  lastWidth = 96;
  private readonly state: BrowserState;
  constructor(
    private readonly term: ProcessTerminal,
    private readonly quit: () => void,
    opts: Options,
  ) {
    this.state = seedBrowser(opts);
  }
  invalidate(): void {}
  render(width: number): string[] {
    this.lastWidth = width;
    this.state.rows = Math.max(10, this.term.rows - 1);
    return browserLines(this.state, width);
  }
  handleInput(data: string): void {
    handleKey(this.state, data, this.lastWidth || 96);
    if (this.state.quit) this.quit();
  }
}

function interactive(opts: Options): void {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const quit = () => {
    tui.stop();
    process.stdout.write("\x1b[?1049l");
    process.exit(0);
  };
  tui.addChild(new Preview(terminal, quit, opts));
  tui.setFocus(tui.children[0] as never);
  process.stdout.write("\x1b[?1049h\x1b[H\x1b[2J");
  tui.start();
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  const code = main(process.argv.slice(2));
  // interactive mode returns while the TUI runs; quit() exits explicitly
  if (code !== 0) process.exit(code);
}
