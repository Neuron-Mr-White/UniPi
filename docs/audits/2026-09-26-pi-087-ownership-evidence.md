# Pi 0.87.1 ownership audit — evidence

Read-only groundwork for the "pi ownership audit" cross-cutting item in
`docs/v3-tasks.md`. Repo state: `v3` @ 3.0.0-alpha.2, pi pins `^0.87.1`,
`node_modules/@earendil-works/pi-coding-agent` = 0.87.1. Pi-side references are
to `node_modules/@earendil-works/pi-coding-agent/{CHANGELOG.md,docs/extensions.md,docs/settings.md}`.
Prefix-cache doc audited against: `docs/prefix-cache-architecture.md` (written
for Pi 0.84.1).

## 1. Prompt-cache warming

**Pi 0.86→0.87.1 provides**

- `CHANGELOG.md:91` (0.86.0): "**Prompt cache warming** — Keep valuable prompt
  caches alive during long tool runs and optionally while idle using
  cost-aware refreshes."
- `CHANGELOG.md:115` (0.86.0): "cost-aware prompt-cache warming during long
  tool runs and optionally while idle, with configurable modes, model
  cache-lifetime metadata, `/session` diagnostics, transcript notices, and the
  `cache_warming_decision` extension event."
- `docs/settings.md:19`: `cacheWarming` setting `"off" | "streaming" | "idle"`,
  default `"streaming"`; runs only when the model declares a cache lifetime
  and ≥$0.05 avoided-miss cost is estimated; refresh usage counts toward
  totals but never enters context; `cache_warming_decision` can override per
  decision (`docs/extensions.md:113`).
- `CHANGELOG.md:59` (0.87.0): "Fixed idle prompt-cache warming rebuilding
  expired caches when its timer or an extension decision is delayed."

**unipi does today**

- `packages/utility/src/prefix-cache.ts` + `utility/src/index.ts:77,163-167`:
  `PrefixCacheTracker` observes `before_provider_request` payloads (HMAC
  fingerprints only, no payload retained), classifies first/retry/extend/
  envelope-change/rewrite, exposes `/unipi:prefix-cache`. Observation only —
  unipi never warms and never has.
- `docs/prefix-cache-architecture.md` rules 1–8 are append-only discipline the
  whole suite follows; warming is not mentioned.

**Overlap/conflict**

- Pi now warms by default (`streaming` mode). Warming requests are extra
  provider requests whose payload shape is the full conversation prefix; the
  tracker should classify them (it has no purpose classification —
  `prefix-cache-architecture.md` "Pi API boundary" already notes
  before_provider_request "has no request ID, retry index, or purpose
  classification"). Unverified whether warming requests surface through
  `before_provider_request` at all — if they do, they may inflate or confuse
  the `/unipi:prefix-cache` fingerprint sequence classification.
- `cacheWarming` is a pi global setting; unipi does not read or surface it.
- No unipi code warms caches — nothing conflicts, only coexistence with the
  new traffic and the new `cache_warming_decision` event (unused).

## 2. Transcript-aware prompt/tool updates

**Pi 0.87 provides**

- `CHANGELOG.md:93` (0.86.0): "**Transcript-aware prompt and tool updates** —
  Preserve instruction and tool changes across resume and branch navigation
  while retaining cached prefixes."
- `docs/extensions.md:101`: `before_agent_start` exposes the prompt AND
  structured `systemPromptOptions`. "Prefer changing prompt sections,
  selected tools, or guidelines so Pi can append a transcript delta.
  Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the
  whole prompt for that run while the transcript continues recording the
  structured sections."
- `docs/extensions.md:142`: "Register every tool first, keep optional tools
  inactive, and use `pi.setActiveTools()` … Names must already be registered."
- `docs/extensions.md` (post-:142 paragraph): "Pi records the initial prompt
  and tool set in the transcript's first system message, then appends tool
  and prompt changes before the next model request. Providers that cannot
  represent the transition receive a complete transcript checkpoint, which
  can invalidate the cached prefix."

**unipi does today**

- `setActiveTools` mid-session callers:
  - `packages/memory/index.ts:171` — `write=false` strips memory_store/delete at session_start.
  - `packages/memory/commands.ts:94` — `/unipi:memory write on|off` toggles live.
  - `packages/image/src/index.ts:51` — vision gating swaps `image_recognize` on model change.
  - `packages/background-tasks/src/delegate-extension.ts:650` — ensures delegate tools active at session_start.
  - `packages/background-tasks/src/delegate-child-extension.ts:454` — `setActiveTools([])` (side session).
  - `packages/subagents/src/agent-runner.ts:204` — `session.setActiveToolsByName` on the spawned AgentSession (filtered set).
- Whole-prompt replacement via `before_agent_start` return `{systemPrompt}`:
  - `packages/fusion/src/index.ts:307` — `systemPrompt + leadPolicy` fragment when fusion active.
  - `packages/long-horizon/src/gate.ts:225-232` — `systemPrompt + renderModeFragment(...)` every turn.
- Structured-section mutation (the preferred 0.87 path): `packages/utility/src/skill-discovery.ts:420-432` mutates `event.systemPromptOptions.skills` in place (filters bundled skills when mode=off).
- `filterPayloadTools` via `before_provider_request`: `packages/long-horizon/src/gate.ts:236-239` rewrites `event.payload.tools` per mode + `tool_call` block fallback (gate.ts:241-258).
- Kanboard turn window: `packages/kanboard/src/commands.ts:1220-1231` enforces via `tool_call` block on bash subcommands (no tool-list mutation).

**Overlap/conflict**

- Fusion and long-horizon both take the *whole-prompt* path
  (`{systemPrompt}`) rather than mutating `systemPromptOptions`; per docs this
  makes the provider's leading system prompt forced text each run and skips
  the structured transcript-delta mechanism. Whether the structured options
  carry an equivalent "guidelines/fragment" section these two could use
  instead is unchecked — the doc only documents `systemPromptOptions.skills`.
- The new transcript-delta mechanism changes what resume/branch does with
  mid-session tool changes: pi now persists them in the transcript. Previously
  unipi re-applied tool gating at session_start (memory write toggle) — still
  does; consistent.
- `setActiveTools` on providers that "cannot represent the transition"
  triggers a "complete transcript checkpoint" → explicit cache-miss boundary
  (already listed as an intentional boundary in the matrix, still true).

## 3. Compaction

**Pi 0.87 provides**

- `CHANGELOG.md:95` (0.86.0): "**Per-model compaction budgets** — Configure
  reserved and recent-token budgets by model"; `:110`
  `compaction.modelOverrides` `reserveTokens`/`keepRecentTokens`.
- `CHANGELOG.md` (0.87.0): "Added retain-none compaction input:
  `sessionManager.appendCompaction(summary, null, tokensBefore)`"; "Added
  actionable `turn_end` and `agent_before_settle` extension boundaries …
  `compaction` entries".
- `CHANGELOG.md` (0.87.1): "Fixed split-turn compaction summaries being
  refused by Claude Fable 5.1 by clearly separating the conversation and
  using continuation-oriented instructions"; "Fixed edited-context accounting
  both discarding valid assistant usage captured after the latest context
  edit and reusing that usage after a later compaction made it stale".
- `docs/extensions.md:152`: `ExtensionContext` "controls for compaction".

**unipi does today**

- `packages/compactor/` — the whole zero-LLM compactor: `index.ts:239-275`
  triggers percentage auto-compaction on `agent_end` via `ctx.compact()`
  (comment: turn_end would abort the in-flight request — `index.ts:232-236`);
  `compaction/hooks.ts:190+` handles `session_before_compact` (builds its own
  deterministic cut), `:352` `session_compact` bookkeeping; `hooks.ts:48-71`
  auto-continue marker appended `deliverAs:"followUp"`.
- `session_compact` consumers: `packages/memory/index.ts:447` (resets
  recallDone), `packages/long-horizon/src/runtime.ts:251` (arms recovery
  fragment on next continuation).
- Compactor config keys: `autoCompaction.{enabled,thresholdPercent}`,
  `overrideDefaultCompaction` (`compactor/src/config/schema.ts:46`,
  `hooks.ts:190-197` — opt-in gate).
- `docs/prefix-cache-architecture.md` Compaction section: asserts "UniPi
  currently performs deterministic, zero-LLM compaction … Pi core's
  reserve-token safety trigger remains active … core compaction triggers
  above contextWindow - 16,384, retains ~20,000 recent tokens."

**Overlap/conflict**

- Both pi (native trigger) and the compactor (percentage trigger, off by
  default) can initiate `ctx.compact`; the compactor's `session_before_compact`
  handler replaces the content when its marker or `overrideDefaultCompaction`
  is set, otherwise yields to pi. Per-model `reserveTokens`/`keepRecentTokens`
  (0.86) now changes pi's cut economics independently of the compactor's
  configured budget display (`compactor/src/tools/context-budget.ts` computes
  its own numbers — modelOverride values are not consulted).
- New `turn_end`/`agent_before_settle` actionable boundaries can propose
  `compaction` entries — unipi uses neither event (gate.ts uses
  before_provider_request + tool_call; nothing emits boundaries).
- `appendCompaction(summary, null, ...)` is a pi-native way to store a
  compaction entry — unipi's compactor builds entries through the
  `session_before_compact`/`session_compact` event pair instead.
- **unverified-but-flagged**: compactor triggers `ctx.compact` on `agent_end`;
  pi 0.87 "Deferred runs requested from `agent_settled` handlers until all
  settled handlers finish" changes ordering guarantees around settled-time
  work — the compact() call itself is still before-end; no direct conflict
  observed, but any future settled-time compaction is affected.

## 4. Deferred tool loading

**Pi provides**

- `CHANGELOG.md:913` (0.80.7): "**Cache-friendly dynamic tool loading** —
  Extensions can add tools during execution while supported Anthropic and
  OpenAI Responses models preserve prompt-cache prefixes."
- `docs/extensions.md:142`: loader-tool pattern — register all tools,
  keep optional inactive, `pi.setActiveTools()` selects them live.
- `docs/extensions.md` examples: `dynamic-tools.ts`.

**unipi does today**

- No loader-tool pattern in unipi. Tool availability changes are done via
  `setActiveTools` at session_start or on config toggles (memory, image) —
  i.e. coarse on/off, not progressive disclosure.
- `packages/utility/src/skill-discovery.ts` implements *skill-catalog*
  disclosure, not tool loading: jev scores skills once per session, hidden
  skills are dropped from `systemPromptOptions.skills`; `SKILL_REVEAL_EVENT`
  re-reveals via an append-only persisted entry (`skill-discovery.ts:361-368`,
  frozen per session, byte-identical system prompt afterward).
- `packages/skill-registry` is a passive package of 20 skills (no loader).

**Overlap/conflict**

- None directly: pi's mechanism is for *tools*; unipi's is for *skills*
  (system-prompt sections). Both chase the same goal (small stable prefix,
  late disclosure) at different layers. Pi's deferred loading keeps the cache
  prefix on supported models; unipi's skill judging keeps the prompt prefix
  byte-identical and never re-adds hidden skills mid-session.

## 5. `context` event users

Pi 0.87 change (`CHANGELOG.md` 0.87.0, Fixed): "`context` handlers that
filter or slice messages dropping the prompt and tool declarations, which
after extension-driven compaction left requests without built-in tools or
made Codex emit raw tool-call text. **Handlers no longer see system
messages; Pi restores the prompt and tool state after they run.**"
`docs/extensions.md:107` repeats this and introduces `context_with_system`
(full transcript incl. system messages, verbatim result).

Every `pi.on("context"` in unipi:

| File:line | Behavior | Filters/slices messages? | Touches system messages? | 0.87 impact |
|---|---|---|---|---|
| `packages/btw/extensions/btw.ts:1900` | drops `isVisibleBtwMessage` markers | yes (custom type filter) | no | fine — same filter, now guaranteed not to see system entries |
| `packages/background-tasks/src/delegate-child-extension.ts:682` | budget measurement + `suppressedMessages` filter; uses `ctx.getSystemPrompt()` for the estimate | yes | no (reads prompt via ctx, not event.messages) | fine; `getSystemPrompt()` still the prompt accessor |
| `packages/compactor/src/compaction/hooks.ts:176` | drops `AUTO_CONTINUE_CUSTOM_TYPE` custom marker | yes (customType filter) | no | fine |
| `packages/kanboard/src/commands.ts:1211` | drops HELP/DOCTOR/SHOW custom types | yes | no | fine |

No unipi `context` handler reads, mutates, or reorders system messages — the
0.87 removal of system messages from `event.messages` is compatible. All four
are additive-safe: previously each filter could accidentally drop a system
entry; that class of bug is now impossible.

No unipi code uses `context_with_system` (new event).

## 6. ContextEditEntry / SessionEntry switchers

Pi 0.87 (`CHANGELOG.md` 0.87.0, Breaking): "Added `ContextEditEntry` to the
exported `SessionEntry` union. TypeScript consumers with exhaustive entry
switches must handle `context_edit`; use `replacement: null` for omission and
a content replacement otherwise." Also "Made `SessionManager` canonical for
`AgentSession` provider context. **Assigning `session.agent.state.messages`
no longer replaces future request history**; restore with
`SessionManager.inMemory(cwd, { id }, entries)`, navigate with
`session.navigateTree()`, or append through `session.sessionManager` and call
`session.refreshContext()`."

unipi SessionEntry consumers (all `entry.type ===` checks, non-exhaustive):

- `packages/compactor/src/session/recall-blocks.ts:66-80` — switches on
  `message`/`custom_message`/`branch_summary`/`compaction`; a `context_edit`
  entry simply matches none → skipped. Compiles; whether recall should
  *interpret* context edits (a model-visible omission) is a semantic gap
  worth noting, not a type error.
- `packages/compactor/src/compaction/cut.ts:43-100,280` — same non-exhaustive
  checks; `context_edit` entries are passed through the cut untouched.
- `packages/background-tasks/src/context-parent-snapshot.ts:48-65` —
  `entry.type !== 'message'` guard; context_edit skipped.
- Full `tsc` is clean — no exhaustive `switch(entry.type)` hits `context_edit`.

`agent.state.messages` usage:

- `packages/btw/extensions/btw.ts:1365` —
  `session.agent.state.messages = seedMessages` **is the pattern the
  changelog explicitly broke**: under 0.87 this no longer affects future
  request history, so the BTW side-session presumably starts with an empty
  context regardless of seeds (breakage, needs SessionManager-based seeding
  or `refreshContext()`). `btw.ts:872-873,907` read `session.state.messages`
  — reads are unaffected.
- No other write of `agent.state.messages` found outside tests.

## 7. Other 0.87 API changes vs unipi usage

| Pi change (changelog line) | unipi touchpoint | Status |
|---|---|---|
| `shouldStopAfterTurn` agent option removed → `finishTurn` returning `{action:"end"}` (0.87.0 Breaking) | grep: zero non-test usages of `shouldStopAfterTurn` or `finishTurn` | unaffected |
| `ExtensionRunner.emit()` no longer accepts `turn_end`; boundary dispatch via `emitBoundary(baseEvent, buildContext)` | unipi uses `pi.events.emit` only for its own bus (`subagents/src/index.ts:206,217`) — not the runner's boundary API | unaffected |
| `TurnEndEvent` boundary fields + `AgentBeforeSettleEvent` added to `ExtensionEvent` union | no unipi code constructs or switches on these events | unaffected |
| Deferred `agent_settled` handler runs until all settled handlers finish | `long-horizon`, `fusion` listen to agent lifecycle? — unipi uses `agent_end` (compactor/index.ts:239), `session_start`, `turn_end`-adjacent hooks only via `tool_call`/`context`; `agent_settled` unused | unaffected |
| `context` handlers no longer see system messages | covered in §5 | compatible |
| Pi restores prompt/tool state after `context` handlers (fixes "left requests without built-in tools") | same §5 | compatible |
| `context_with_system` new event | unused | n/a |
| per-model image resize profiles `inputLimits.images.resize` (0.87.0) | `packages/image` does its own gating (`index.ts:51` on/off only, no resize config) | no conflict; pi feature unused |
| strict-prefer JSON-schema sampling default for built-ins (0.86.1 `:125`) | unipi re-registers no built-in tools; `constrainedSampling` unused | unaffected |
| Node persistent compile cache (0.86.1) | n/a | benefit only |
| moved spinners into editor border (0.86.1 `:124`) | footer overlays separate | unaffected |
| "missing or invalid `--mode` values no longer silently ignored" (0.87.1) | unipi-dev/pi launches don't pass `--mode` | unaffected |

## Gap-matrix re-check (`docs/prefix-cache-architecture.md`, vs Pi 0.84.1)

Stale rows:

- **"Ralph iteration state — `unipi-ralph-loop-reminder` tail snapshots"** —
  the ralph package was removed; the string `unipi-ralph-loop-reminder` no
  longer exists. long-horizon now owns loop state via `sendUserMessage`
  `deliverAs:"steer"` (`long-horizon/src/runtime.ts:154`,
  `engine/runaway.ts:62`) — same append-only discipline, different mechanism.
- **"Workflow sandbox — Stable tool schemas; `tool_call` blocks disallowed
  execution"** — `sandbox.ts` is deleted; enforcement moved to the
  permission/plan-mode `tool_call` gate in `packages/workflow/`. Same
  pattern, row name out of date.
- **"Memory reminders"** — still valid but re-authored: reminders are custom
  entries `RECALL_CUSTOM_TYPE`/`RETRO_CUSTOM_TYPE` (`memory/index.ts:415,435`)
  sent `deliverAs:"nextTurn"` (`index.ts:443`).
- **"Utility continuation — `/continue` sends a hidden tail message"** —
  `/unipi:continue` still exists (`utility`, registered in the autocomplete
  registry); row premise still holds, wording just predates the v3 command
  namespace.
- **"Oversized paginated search/recall output — CocoIndex …"** — CocoIndex is
  gone from the tree (no references); the recall cap claim needs re-derivation
  against the new memory package.
- **"Compaction … percentage trigger"** — section's hard numbers
  ("contextWindow − 16,384", "~20,000 recent") describe pre-`modelOverrides`
  pi; `compaction.modelOverrides` can now change both per model.
- **Missing rows**: long-horizon owner/gate (mode fragment on
  before_agent_start + payload tool filter — a per-turn *provider-payload*
  rewrite, the most aggressive surface in the suite); kanboard turn window;
  memory `/unipi:memory write` live tool toggling; pi-side `cacheWarming`
  (new request traffic, §1); `context_with_system` (unused); ContextEditEntry
  (§6).

Fixed rows that remain accurate: MCP discovery/order, JSON-schema
canonicalization, subagent type descriptions, tool-catalog boundary,
provider/thinking changes, resume/fork boundaries, helper/BTW sessions,
host-owned rows, prefix-cache diagnostic, oversized spill caps.

## Notes for the decision pass

- BTW `agent.state.messages = seedMessages` is the only confirmed-broken
  behavior change found (0.87 canonical-SessionManager change).
- The four `context` filters compile and behave identically under 0.87 — the
  0.87 fix removes a foot-gun class, doesn't require action.
- fusion + long-horizon's `{systemPrompt}` replacement is legal but bypasses
  the structured `systemPromptOptions` mechanism pi added for cache-retaining
  prompt updates; utility already uses the new mechanism.
- No unipi code warms caches, emits `cache_warming_decision`, uses
  `context_with_system`, `appendCompaction`, `appendContextEdit`, `emitBoundary`,
  `finishTurn`, or `shouldStopAfterTurn`.
