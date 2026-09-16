# Spec: Devin-style model picker, Local Fusion (lead + sidekick), bg-tasks enchant

Status: APPROVED by user (2026-09-15 grilling session). §1–3 IMPLEMENTED 2026-09-15 on
`fix/model-picker-v2` (packages/fusion: picker restyle + slider, sidekick runtime, `sidekick` /
`read_subagent` tools, lead policy, nudge, savings). Deviations from §3: tool is named
`read_subagent({agent_id?, block?, timeout?})` (Devin's name/shape) not `sidekick_read`; blocking
`sidekick` returns early with status `interrupted` when `ctx.hasPendingMessages()` so the lead can act
on a user message mid-handoff (pi delivers steer messages only after the tool returns).
Source material:
- Screenshots: /home/oi/Pictures/unipi-vs-devin/*.png
- Blog: https://cognition.com/blog/devin-fusion
- Devin CLI binary strings (chisel-agent/src/local_fusion/sidekick_tool.rs) — extracted to /tmp/devin-strings.txt
- Live tmux observation of `devin` → `/model`

Goal is to *learn the architecture and implement it*, not copy it.

**UX correction pass (later session).** §3 was implemented as *a tool that calls a subagent* rather than *one model*, which produced three defects: `ask_user` silently self-cancelling in the sidekick, the session looking idle while the sidekick worked, and the transcript collapsing to a stub. All three are fixed; see "Sidekick is not a tool, it is the other half of one model" below.

---

## 0. Hard facts about pi 0.84.2 that constrain the design

- `/model` is intercepted in `defaultEditor.onSubmit` (interactive-mode.js:2343) **before** `session.prompt()` → the `input` extension event never sees it. Extension commands named `model` are renamed (`/model:2`) and skipped in autocomplete.
  → We do NOT override `/model`. We ship **`/unipi:model`** and make it the **top autocomplete hit when the user types `/model`** (autocomplete provider wrapper; packages/autocomplete already wraps the provider).
- `Model` has only `cost {input,output,cacheRead,cacheWrite}`, `reasoning`, `contextWindow`, `maxTokens`, `name`. No capability score / badges / fast mode → those are **preset metadata or omitted**.
- Thinking level is global (`pi.setThinkingLevel`, off/minimal/low/medium/high/xhigh).
- Existing `fusion_*` council (candidates×3 + evaluator + merger) and `/unipi:fusion-models` are **not** what the user wants → removed.

---

## 1. `/unipi:fusion-preset` (curates the finite model list)

Storage (Q8 = global + project override):
- Global: `~/.pi/agent/unipi/fusion-preset.json`
- Project: `<cwd>/.unipi/fusion-preset.json` — deep-merged on top (arrays replace, objects merge).

```jsonc
{
  "schema_version": 1,
  "lead":     ["anthropic/claude-opus-4-6", "omniroute/antigravity/claude-opus-4-6-thinking"],
  "sidekick": ["omniroute/zai/glm-5.3-flash", "omniroute/deepseek/v4-flash"],
  "default":  { "lead": "anthropic/claude-opus-4-6", "sidekick": "omniroute/zai/glm-5.3-flash" },
  "effort":   { "anthropic/claude-opus-4-6": "medium", "omniroute/zai/glm-5.3-flash": "high" },  // per-model remembered effort (Q4=1)
  "recent":   ["anthropic/claude-opus-4-6", "..."]  // max 5, MRU, written by the picker
}
```
- Command UI: two-column checklist over `modelRegistry.getAvailable()` (space toggles lead / sidekick membership, `d` sets default, `s` saves). Search filter. Reuses the shape of `ui/fusion-model-selector.ts` but for lists, not slots.
- Any model is allowed (user freedom). **No** `assertSubscriptionRoute` gate.

## 2. `/unipi:model` picker (Devin layout)

Row layout (observed): `❭ Name  [✱badge]  ← effort →   Effort-label    [Lead ▾  Sidekick ▾]`
Only the highlighted row shows the `←/→` arrows and extra columns.

List order:
1. **Currently selected** entry pinned at top (Fusion or a single model) — Q5.
2. **Recent** (≤5, MRU) from preset.
3. Rest of the preset models (lead ∪ sidekick), then — if preset is empty — all available models.
Search (`/ type to search`) filters 2-3; pinned row stays.

Row types:
- `Fusion` row: effort = lead effort; extra `Lead <name> ▾ · Sidekick <name> ▾` columns.
- Single-model rows: effort per model (from preset.effort, default = current global level).

Keys (from Devin, verified in tmux):
- `↑↓` select · `↵` confirm · `esc` cancel · typing = search
- `←/→` effort: `off → minimal → low → medium → high → xhigh` (pi's levels; clamps, no wrap). Devin labels: None/Low/Medium/High/XHigh/Max — we show pi's names.
- `tab` on the Fusion row cycles focus: **effort → lead → sidekick → effort**. When lead/sidekick focused, an inline dropdown opens under the column listing preset.lead / preset.sidekick; `↑↓` moves, `↵` confirms, `esc` collapses. (Devin also has Fast Mode; we skip it — Q5.)
- Hint line updates per focus: `↑↓ select · tab lead · ←→ effort · ↵ confirm · esc cancel` → `↑↓ select · tab sidekick · ↵ confirm · esc collapse`.

Bottom panel (Q5 = price panel only):
```
Input      Cached input   Output     [Sidekick input   Sidekick cached   Sidekick output]
$10 / 1M   $0.25 / 1M     $50 / 1M   $0.2 / 1M         $0.02 / 1M        $1.2 / 1M
```
from `model.cost` (input / cacheRead / output). No slider, no capability bar, no badges in v1.

On confirm:
- Single model: `pi.setModel(m)`, `pi.setThinkingLevel(effort[m])`, push to recent, fusion.active=false.
- Fusion: `pi.setModel(lead)`, `pi.setThinkingLevel(effort[lead])`, fusion.active=true, store sidekick+its effort in session state; footer shows `Fusion · <Lead> ◆ <Sidekick>` via `ctx.ui.setStatus`.

## 3. Local Fusion runtime — sidekick (Q3 decided = follow Devin; Q6 = follow Devin)

Architecture learned from the Devin binary:
- **Exactly one persistent sidekick per session.** Its conversation context and runtime (shells, dev servers) persist across handoffs. Same machine/cwd, separate shell sessions.
- Tool **`sidekick({ message, block = true })`**: blocking waits and returns the report, streaming progress; `block:false` returns immediately and the report arrives as a `<subagent_completion_notification>`. Calling `sidekick` while one is running **injects the message as an interrupt** into the running handoff (never spawns a second).
- Tool **`sidekick_read({ block = true, timeout? })`** to wait/peek (Devin's `read_subagent`).
- Sidekick never sees user messages — only the brief. Cannot talk to user; does not own commits/PRs.
- Lead system prompt section `## Sidekick` (delegate-by-default policy). Nudge `<system_guidance>You made a direct edit yourself instead of delegating to Sidekick…</system_guidance>` once after the lead's first direct edit/write.
- Sidekick has independent compaction thresholds.
- Savings display: "Estimated Fusion savings — estimated by sidekick tokens at lead prices".

unipi implementation:
- New package `packages/fusion` (replaces council code in background-tasks):
  - `sidekick-runtime.ts`: one long-lived `pi --mode rpc` child (reuse `packages/subagents/src/pi-spawn.ts` spawn + JSON event streaming; add rpc `steer` for interrupt-injection; `--session` file for persistence; `--model <sidekick> --thinking <effort>`; full tool set, same cwd). Lazy-spawned on first `sidekick` call; killed on session end / fusion off.
  - `tools.ts`: `sidekick`, `sidekick_read`. Blocking mode streams the child's tool calls into the tool card via `onUpdate`; non-blocking sends `pi.sendMessage({customType:'sidekick-completion', deliverAs:'followUp', triggerTurn:true})`.
  - `lead-policy.ts`: `before_agent_start` → append the `## Sidekick` section (adapted from Devin's text: delegate implementation/verification/env repair/broad search; keep planning, correctness-critical authoring, diff review, user-facing actions; "specify the code, don't describe it"; one blocking handoff beats non-blocking warm-up; batch rework into one brief) only when fusion.active.
  - `nudge.ts`: `tool_call` hook — first `edit`/`write` by lead while fusion.active → inject one-time system_guidance reminder (tool_result append). Setting `unipi.fusion.firstEditReminder` (default true).
  - `savings.ts`: track sidekick token usage from child events; compute `Σ sidekick tokens × lead price − Σ sidekick tokens × sidekick price`; show in footer status + `/unipi:fusion-stats`.
- Not in v1: compaction-time dynamic routing.

### Sidekick is not a tool, it is the other half of one model

The governing fact, verified in `~/.pi/agent/extensions/herdr-agent-state.ts` (herdr installs its own pi
extension; it is not in this repo and is overwritten on herdr update):

```js
pi.on("agent_settled", (_event, ctx) => {
  if (!rootSession || ctx?.isIdle?.() !== true) return;   // stays "working"
  agentActive = false;
});
```

herdr's `working`/`idle`, pi's loader, and pi's elapsed timer are **not three things to synchronise**.
They all derive from one fact: whether pi considers the turn over. herdr does not screen-scrape while
an integration holds authority (`herdr agent explain` → `rule: none`,
`screen_detection_skip_reason: full_lifecycle_hook_authority`), and pi is entirely herdr-unaware
(`grep -ril herdr node_modules/@earendil-works/` → 0 files).

Consequences, all of which we got wrong first time:

1. **The only way to stay "working" is to genuinely still be working** — the `sidekick` tool call must
   not have returned. Blocking-by-default is therefore an architectural requirement, not a preference.
   Do not reach for a display fix (widget, status field, tool card) for a turn-lifecycle problem.
2. **`herdr:blocked` is the wrong lever.** It can only ever produce `blocked`, never `working`; it is a
   counter, so an unbalanced pair sticks the pane permanently; it means "a human is being asked
   something"; and `active:false` disarms notify's renotify loop (`packages/notify/events.ts:241-246`).
3. **The sidekick child has no voice in herdr at all** — `rootSession` is set only when `ctx.mode === "tui"`,
   and the child runs `--mode rpc`.
4. **`ctx.hasUI` is true in RPC mode but `ui.custom()` is a stub returning `undefined`**
   (`rpc-mode.js:152` vs `runner.js:274`). Any `ui.custom`-based tool in the child therefore takes its
   *cancel* branch silently. `ask_user` reported "User cancelled the selection" without the user ever
   seeing a prompt. Guarded via `isSubagentChild()` in `packages/ask-user/tools.ts`: the sidekick never
   talks to the user, so it must escalate the question to the lead (the blog's "interpretation of
   ambiguity" is the lead's job).
5. **Turns that end anyway must still wake the lead.** A handoff abandoned by an interrupt or a timeout
   used to sit in `runtime.reports` unread. `createCompletionDelivery()` in `packages/fusion/src/tools.ts`
   gives exactly-once delivery via `attach`/`detach`/`consume`; §4 UX fix 1's wake line covers the
   visible gap.
6. **Reuse §4's wake-line pattern rather than inventing one.** `pendingWakeText` + `createSpinnerLine`
   already solved "looks idle but isn't" for bg tasks; it simply had never been applied to the sidekick.
   `createSpinnerLine` owns an 80 ms frame timer, so it needs an install-once latch.

## 4. Background-tasks enchant (Q7)

Scope after cleanup — **bg tasks only**:
- Keep: `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `bg_delegate`+`bg_result` (agent-in-background), task-manager overlay (Shift+Down), `/unipi:bg`, `/unipi:bg-settings`, footer dock counts.
- Remove: `bg_run_pi_attested`, all `fusion_*` council tools + `/unipi:fusion`, `/unipi:fusion-models`, `ui/fusion-model-selector.ts`, `fusion/*`, `anthropic-attribution` / `/unipi:claude-cache`, duplicate commands (`/unipi:tasks`, `/unipi:bg-tasks`, `/unipi:jobs`, `/unipi:logs`, `/unipi:kill`, `/unipi:bg-clear`, `/unipi:bg-update` → fold into overlay).
- Bug (found live): `bg_delegate` fails in the npm install — `packages/background-tasks/src/delegate/hook-contract-evidence.json` is not in root `package.json` `files` (only `*.ts` globs) → ENOENT. Fix: add `"packages/*/src/**/*.json"` and ship a patch.

UX fixes (found live in tmux):
1. **Pending-wake indicator.** After a bg task is launched with `triggerOnCompletion`, the agent turn ends and the UI looks idle → user thinks it's done. Show a working-style indicator (`ctx.ui.setWorkingMessage` / footer status pulse) `⏳ waiting on 1 bg task (Sleep 25 · 12s) — will resume automatically` until the notification fires. Clear when no pending-wake tasks remain.
2. **Colored completion card.** The `[bg completed] … Output: …` line has no background and is lost in the chat. Render the notification message (`registerMessageRenderer('background-task-notification')`) as a boxed/tinted card: `▎ bg ✓ Sleep 25 echo done · exit 0 · 25s` + last 3 output lines, colour by status (success/error/warning). Same treatment for `sidekick-completion`.
3. Launch card: tint `bg_run` tool result too (`● started …`), so start/finish pair visually.
4. Overlay: show elapsed, last output line, and the "will wake agent" flag per row.

## 5. Delivery order (Q9 = any) — proposed
1. bg-tasks: ship `hook-contract-evidence.json` fix + trim + UX 1-4 (smallest blast radius, unblocks daily use).
2. `/unipi:fusion-preset` + `/unipi:model` picker + autocomplete boost.
3. `packages/fusion` sidekick runtime + lead policy + savings.

Each step = its own branch/PR, typecheck + tests, tmux smoke test, then release.
