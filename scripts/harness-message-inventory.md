# UNI-49 inventory — harness-origin messages that arrive as user content

Mechanical source classification (working tree `5fc316b`). Every row was checked
against the source; transports, custom types and renderers cite file:line. This
inventory backs `harness-message-preview.ts` (DESIGN PREVIEW — no live renderer
or model-role changes). "Model role" is the role the payload occupies in the
model context.

## Renderer facts the distinction builds on (factual, verified)

- **Direct transport** — `pi.sendUserMessage(...)` produces a plain user-role
  message rendered by pi's native `UserMessageComponent`
  (`node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js`:
  markdown in a `userMessageBg` box). Provenance is therefore **invisible**:
  harness text looks exactly like human text.
- **Custom transport** — `pi.sendMessage({ customType, content })` renders
  through `CustomMessageComponent`
  (`.../components/custom-message.js`): a label built from the `customType` plus
  a `customMessageBg` box — distinct from human text, but generic (no origin
  identity per source).
- **Dedicated renderers** — extensions can replace the generic card via
  `pi.registerMessageRenderer` (memory, background-tasks, fusion, subagents,
  kanboard show do). Those messages are already visually distinct.
- **System role is possible upstream** — pi supports structured system sections:
  `before_agent_start` handlers can patch prompt options
  (`systemPromptOptions.sections`; consumed by `_preparePromptAndToolLoadout` in
  `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`).
  So "append as system" is not categorically impossible — it is an alternative
  transport some of these could migrate to. This preview deliberately keeps the
  **user model role unchanged** and changes presentation only.
- **Human-origin protection** — classification must come from source/transport
  provenance metadata, never from text heuristics: a human literally typing
  "No-progress guard: …" must stay human (fixture `human-marker-prefix`).

## A. Harness-generated, DIRECT user-origin transport (`sendUserMessage`)

| Source function/path | Origin | Raw transport | Model role | Current UI renderer / visibility | Proposed category |
|---|---|---|---|---|---|
| `packages/long-horizon/src/runtime.ts:224` (RunawayGuard steer; text from `engine/runaway.ts runawayNudgeText` + `ANTI_POISONING_SUFFIX`) | harness (progress guard) | `pi.sendUserMessage(text, { deliverAs: "steer" })` | user | native `UserMessageComponent` — looks human | harness · warning tone, violet provenance |
| `packages/long-horizon/index.ts:160-161` (`sendNow` timer continuation) | harness (goal continuation) | `sendUserMessage(message, { deliverAs: "followUp" })` / plain | user | native — looks human | harness |
| `packages/long-horizon/src/commands.ts:250` (owner resume fixed text) | harness (command wrapper) | `sendUserMessage(text)` | user | native — looks human | harness |
| `packages/kanboard/src/commands.ts:1426,1462` (`doText`/`autoworkText`, `src/commands.ts:45,53`) | harness (budget grant) | `sendUserMessage(...)` (followUp when busy) | user | native — looks human; `Request:` section is verbatim user-task data | harness · USER REQUEST data split labeled, payload unchanged |
| `packages/memory/commands.ts:229,240` (memory-process / consolidate wrappers) | harness (command wrapper) | `sendUserMessage(...)` | user | native — looks human | harness |
| `packages/workflow/src/plan/index.ts:100-105` (`approvePlan` approved-plan wrapper) | harness (approval handoff) | `sendUserMessage(text, { deliverAs: "followUp" })` | user | native — looks human | harness |
| `packages/watchdog/index.ts:461` (abort notice, text at 457-463, quoted toolName only) | harness (watchdog) | `sendUserMessage(text, { deliverAs: "followUp" })` | user | native — looks human | harness · warning tone |
| `packages/utility/src/answer/index.ts:210` (`/unipi:answer` — `composeAnswers` output, `extract.ts:108`) | **user-authored** (answers the user typed/picked) | `sendUserMessage(message)` / followUp | user | native — correctly human | **stays human (D)** |

## B. Harness-generated, custom-serialized user content — `sendMessage` customType, boundary custom_message entries, hook-injected messages

| Source function/path | Origin | Raw transport | Model role | Current UI renderer / visibility | Proposed category |
|---|---|---|---|---|---|
| `packages/long-horizon/index.ts:169-183` (arbiter nudge stash → `unipi:lh-continue`; carries goal kickoff/continuation/no-progress/no-tool/recovery/audit/budget wrap-up from `prompts/goal.ts`, Ralph kickoff/iteration/reflection from `engine/ralph.ts`) | harness | nudge-provider stash → **boundary custom_message entry** (`CustomMessageEntryDraft` `type:'custom_message'`, core `turn/arbiter.ts:264`) — no direct `sendMessage` call; projects to role custom | user (serialized) | generic `CustomMessageComponent` / default renderer label card | harness · origin-consistent panel |
| `packages/kanboard/src/monitor.ts:18-19` (`CLAIMS_NUDGE_CUSTOM_TYPE unipi:kanboard-continue` 242-247, cap `MAX_NUDGES_PER_TASK=5`; `AUTOWORK_NUDGE_CUSTOM_TYPE unipi:kanboard-next` 292-299) | harness | nudge provider → **boundary custom_message entry** — not the `sendMessage` API; projects to role custom | user (serialized) | generic `CustomMessageComponent` / default renderer label card | harness · warning tone + anti-poison suffix preserved |
| `packages/memory/index.ts:51-52` (`unipi-memory-recall-reminder` `buildMemoryRecallReminder`:81 — injected via `before_agent_start` return.message; `unipi-memory-retro-reminder` :556-568, `sendMessage` `deliverAs: "nextTurn"`) | harness | recall: `before_agent_start return.message`; retro: `sendMessage customType` | user (serialized) | **already distinct**: compact badge renderer `memoryCard`, labels "Memory recall"/"Memory save?", first line only (index.ts:173-181) | keep badge; proposal = origin consistency/details expansion — **not** a claim they impersonate human today |
| `packages/skill-registry/index.ts:161,216` (`unipi-skills-revealed`, content `judge.ts revealMessage`:283) | harness | `sendMessage customType` (triggerTurn: false) | user | generic label card | harness |
| `packages/workflow/src/plan/index.ts:153,181,335` (`PLAN_MESSAGE_TYPE = "unipi:plan-mode-message"`, `plan/state.ts:12`; visible on/off + reminder, `planInstructions`:35, `planReminder`:52) | harness | `sendMessage customType` (display: true); the hidden per-turn reminder variant is **not live-visible** | user | generic label card when visible | harness |
| `packages/watchdog/index.ts:225-234` (`unipi-watchdog`, drained pending warnings) | harness | `before_agent_start return.message` customType unipi-watchdog (display: true) | user (serialized) | generic label card | harness · warning tone |
| `packages/compactor/src/commands/index.ts:70` (`compactor-recall` — `/unipi:session-recall` results, `vccRecall` text) | harness (command result) | `sendMessage customType` (triggerTurn: true) | user | generic label card | harness |
| `packages/utility/src/commands.ts:17` (`unipi-response` — /unipi:cleanup, /unipi:doctor markdown) | harness (command result) | `sendMessage customType` (display: true) | user | generic label card | harness |
| `packages/utility/src/commands.ts:31` (`unipi-continue` — **empty** content, **display: false**) | harness (turn kick) | `sendMessage` + `triggerTurn: true` | user | **never rendered** (display:false, empty) | hidden — inventory only |
| `packages/background-tasks/src/tools.ts:164` (`background-task-notification`) | harness | `sendMessage customType` | user | **dedicated renderer `registerMessageRenderer<BgTaskSnapshot>`** | **ALREADY DISTINCT** — stand-in only, never raw XML |
| `packages/fusion/src/tools.ts:182` (`sidekick-completion`) | harness | `sendMessage customType` | user | **dedicated renderer** (`renderCompletionLine`) | **ALREADY DISTINCT** — stand-in only |
| `packages/subagents/src/index.ts:604` (`subagent-completion`) | harness | `sendMessage customType` | user | **dedicated renderer** | **ALREADY DISTINCT** — stand-in only |

## C. Not user messages at all — tool-result annotations

| Source function/path | Origin | Raw transport | Model role | Current UI renderer / visibility | Proposed category |
|---|---|---|---|---|---|
| `packages/fusion/src/index.ts:408` (appends `EDIT_NUDGE`, `prompts.ts:76`) | harness | appended to tool result content | tool | inside the tool card | tool-result annotation (inline warning), never a user-message card |
| `packages/fusion/src/index.ts:415` (appends `bashNudge(count)`, `prompts.ts:87`) | harness | appended to tool result content | tool | inside the tool card | tool-result annotation |
| `packages/kanboard/src/reminders.ts:95` (`r1Text`; registered `index.ts:234-238`) | harness | appended to tool result content | tool | inside the tool card | tool-result annotation |
| `packages/watchdog/index.ts:210-219` (kill warning prepended to killed tool result, isError) | harness | replaces/augments tool result content | tool | tool error card | tool-result annotation |

## D. USER-AUTHORED — must stay human

| Source function/path | Origin | Raw transport | Model role | Current UI renderer / visibility | Proposed category |
|---|---|---|---|---|---|
| Human-typed transcript text (any content, incl. literal "No-progress guard: …") | user | pi user message | user | native `UserMessageComponent` | **human — YOU**, unchanged; no regex classifier |
| `packages/utility/src/answer/index.ts:210` (composeAnswers output) | user (typed/picked answers) | `sendUserMessage` | user | native | stays human |
| `packages/long-horizon/src/commands.ts:301` (`args.trim()` pass-through) | user (command arg) | `sendUserMessage(args.trim())` | user | native | stays human — **USER TASK** |
| `packages/compactor/src/compaction/hooks.ts:403,444-447` (follow-up prompt from user args, manual compaction) | user (typed follow-up) | `sendUserMessage(followUp, { deliverAs: "followUp" })` | user | native | stays human — user task text re-delivered, not generated |
| `packages/ask-user/tools.ts` (`runAction` new_session handoff — `prefill` from the picked option, :43,:201) | **generated wrapper carrying user selection** | queued prefill on handoff | user | native | generated origin wrapper, not human-typed: explicit harness label **if** previewed |

## E. UI-only / never model context — not user-role payloads

| Source function/path | Origin | Raw transport | Model role | Current UI renderer / visibility | Proposed category |
|---|---|---|---|---|---|
| `packages/kanboard/src/commands.ts:1291-1304` (`HELP_CUSTOM_TYPE` "unipi:kanboard-help", `DOCTOR_CUSTOM_TYPE` "unipi:kanboard-doctor", `SHOW_CUSTOM_TYPE` "unipi:kanboard-show" + "unipi:kanboard-notice") | harness/UI | `sendMessage customType` **explicitly dropped by the `context` hook filter** | none (filtered) | only SHOW has a dedicated renderer (:1282); help/doctor stay plain text — all three are removed from context by the hook | UI-only — excluded from the distinction |
| `packages/kanboard/index.ts:137` (notice buffer drains via `appendEntry` + toast) | harness/UI | custom **entries**, never messages | none | entry/toast UI | UI-only |
| tips surfaces | UI | UI-only | none | UI | UI-only |
| `packages/memory/index.ts:195+` (session/save cards via `registerEntryRenderer`) | harness/UI | custom **entries** | none (not sent to model) | entry renderer | UI-only |
| `sidekick-step` / `subagent-step` transcript entries (`packages/utility/src/render/delegated.ts`) | harness/UI | custom entries | none (not model context) | dedicated delegated renderer | UI-only (existing UNI-2/47/48 work) |
| `packages/memory/save-session.ts:34` `SAVE_PROMPT` | harness | one-shot **side session** only | user *in that side session* | never visible in the main session | listed separately — no live transcript card invented for it |

## Upstream (Pi core, not UniPi sources — separate note)

Pi's own compaction summaries, branch summaries, and `!bash` converted user
input arrive as user content from upstream Pi, not from a UniPi extension. They
are out of scope for UniPi-side provenance labels and are not previewed here.

## Preview mapping

Fixtures in `harness-message-preview.ts` carry `origin`, `transport`,
`delivery`, `visibility` and `category` fields copied from the rows above; the
mixed scenario interleaves D (human), harness A/B, a C tool annotation and an
ALREADY-DISTINCT stand-in. Payloads are verbatim representative texts; the
hidden row renders only as an explicit "never rendered" placeholder.
