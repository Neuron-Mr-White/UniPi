# Unreachable and Useless Code Audit

Date: 2026-08-13  
Scope: current UniPi repository  
Mode: read-only production audit, except for the separately requested subagent-default configuration fix

## Executive summary

The codebase did not have a broad syntactic unreachable-code problem: normal TypeScript checking passed, and compiler checks found no unreachable statements. The larger problems were **reachable surfaces that did nothing**, followed by **implementation files shipped but disconnected from the runtime graph**.

### Consolidated disposition (2026-08-13)

- **Fixed or conservatively removed:** findings 2–17, except finding 2 in the original execution checklist (the LLM summarization item below). This includes Compactor injection/config truthfulness, Subagent enablement/packaging, Notify priority, Workflow/Milestone lifecycle, status/event contracts, package entries/manifests/dependencies, nine private dead declarations, and 14 graph-disconnected modules.
- **Explicitly deferred:** LLM summarization provider placeholder (§1), at the user’s request pending a broader Wigolo/web-fetch architecture discussion. It remains a known defect and is not represented as fixed.
- **Disproven/expected behavior:** CocoIndex’s LanceDB and Compactor’s better-sqlite3 are correctly declared optional dependencies; Notify’s event was already fully wired when rechecked; emitter-only integration channels were retained as external hooks rather than mislabeled dead.
- **Compatibility retained:** deprecated Compactor config fields and dormant public event constants remain available where removal would require a major-version policy.

Final validation passed: full root/workspace test command, root typecheck, production build with clean secret scan, package-entry and production-graph contracts, isolated Subagents and Utility tarball tests, and root plus all workspace tarball manifests.

## Method

- Traced the shipped extension from root `package.json` through `packages/unipi/bundled.js` and its source entry `packages/unipi/index.ts`.
- Compared workspace `main`, `exports`, `files`, and Pi metadata.
- Used parallel explore subagents for entry-point, config/event, dependency, and static-symbol audits.
- Used repository-wide symbol/import searches and an esbuild production dependency graph.
- Ran:
  - `npm run typecheck`
  - `npm test --workspace=@pi-unipi/subagents`
  - `npm run build`
- Classified findings conservatively: a source file absent from the bundle is not automatically dead when it is a type module, tested helper, or plausible public deep import.
- Deep-proof phase re-ran every promoted claim with runtime execution, installed SDK contracts, exhaustive symbolic/literal searches, actual tarballs, isolated nested installs, TypeScript scope diagnostics, and a fresh 249-input esbuild metafile. Several initial hypotheses were disproven or narrowed rather than retained.

## Confidence definitions

- **Verified**: current control flow or reference evidence proves the behavior is inert/unreachable inside this repository.
- **High-confidence candidate**: disconnected from all declared runtime/dev entries and has no internal references, but external deep imports cannot be disproved.
- **Review candidate**: likely redundant, but public compatibility or intent must be decided first.

---

## P0/P1: reachable but useless or misleading

### 1. LLM summarization returns a placeholder

**Status:** Confirmed and explicitly deferred on 2026-08-13 pending a broader Wigolo/web-fetch architecture discussion  
**Confidence:** Proven at runtime  
**Impact:** P1 functional defect

`packages/web-api/src/providers/llm-summarize.ts:29-40` accepts web content but never reads it. It returns:

```ts
summary: `[LLM Summary placeholder for ${url}]`
```

The provider is registered and reachable, and `summarize()` calls the placeholder with an empty content string at `packages/web-api/src/providers/llm-summarize.ts:57-64`. Comments claim the tool performs the real LLM call, but the public execution path delegates back to the provider.

**Runtime proof (executed 2026-08-13, `npx tsx`):**

```
ranked summarize providers: [ 'llm-summarize@2' ]
sourceRank=2 chain: [ 'llm-summarize' ]
tool-path summary via rank-2 provider: "[LLM Summary placeholder for https://example.org/article]"
```

Chain traced end to end:

- `web_llm_summarize` tool executes `executeSummarize()` at `packages/web-api/src/tools.ts:200-217`.
- `selectProviderChain("summarize", 2)` returns exactly `[llm-summarize]` (`packages/web-api/src/tools.ts:90-133`).
- `withProviderFallthrough` calls `provider.summarize()` and the placeholder string is returned to the caller (`packages/web-api/src/tools.ts:134-158`), rendered as `Summary of <url>:\n\n[LLM Summary placeholder for <url>]` (`packages/web-api/src/tools.ts:631-637`).
- The provider registers at import time (`packages/web-api/src/providers/llm-summarize.ts:69`) and is imported by the runtime entry (`packages/web-api/src/index.ts:31`), and enabled by default in `packages/web-api/src/settings.ts:77`.
- Only two providers expose summarize capability: perplexity (rank 1) and llm-summarize (rank 2). Auto-selection therefore also serves the placeholder whenever the rank-1 provider fails.

**Check/Gate outcome (2026-08-13):** the original design requires rank-2 `llm-summarize` to fetch page content and use Pi’s active model/credentials. The present `WebProvider.summarize()` boundary receives neither fetched content nor Pi’s tool context, so implementing that design belongs in the tool path (local fetch plus an isolated no-tools model request), not in the current provider placeholder. That would create real LLM cost and must address untrusted-page prompt injection and content limits. Removing rank 2 would instead change fallback/source availability. The user deferred both choices until the planned discussion of Wigolo and web-fetch conflicts. No production code changed for F2; the placeholder remains a known defect.

**Recommendation when resumed:** settle the fetch/provider architecture first, then either implement an isolated content-dependent Pi-model call with mocked integration coverage or unregister source 2. Never retain fake-success placeholder output.

### 2. Compactor exposed inert pipeline flags

**Status:** Fixed by hiding/deprecating the controls on 2026-08-13  
**Original confidence:** Proven by reference  
**Impact before fix:** P1 misleading configuration

These pipeline flags are typed, defaulted, preset-controlled, and UI-editable, but have no runtime consumer:

- `ttlCache`
- `proximityReranking`
- `timelineSort`
- `progressiveThrottling`
- `mmapPragma`

Evidence:

- Defaults: `packages/compactor/src/config/schema.ts:52-59`
- Presets: `packages/compactor/src/config/presets.ts`
- Settings UI: `packages/compactor/src/tui/settings-overlay.ts:154-159`
- Types: `packages/compactor/src/types.ts:120-126`

**Proof (exhaustive reference enumeration, 2026-08-13):** every reference to each of the five flags in `packages/compactor` source (excluding tests) is confined to `types.ts` (type declarations), `config/schema.ts` (defaults), `config/presets.ts` (preset values), and `tui/settings-overlay.ts` (UI getters/setters). No runtime module reads them:

- `rg 'pipeline\.' packages/compactor/src` shows the only runtime reads are `autoInjection` (`src/session/resume-inject.ts:28`) and `customNoisePatterns` (`src/index.ts:267,273`, `src/tools/register.ts:167`, `src/commands/index.ts:106`).
- No dynamic dispatch over pipeline keys exists (`Object.keys(pipeline)`, `pipeline[...]` absent in runtime modules).
- The built bundle contains the flags only in schema/preset/UI code (e.g. `bundled.js:3856` schema default, `5560/5586/5616` presets, `5822` settings overlay entry); no execution path references them.

By contrast, `customNoisePatterns` is consumed in `packages/compactor/src/index.ts:267,273` and `packages/compactor/src/tools/register.ts:167`.

**Resolution (Check → Fix → Test):**

The original UX documents specified preset on/off matrices but no executable semantics or acceptance criteria. Implementing guessed behavior would change recall ordering, latency, caching, and SQLite resource usage. With user approval, the five fields were therefore deprecated and hidden rather than given speculative implementations:

- Removed their rows from the Pipeline settings tab; only implemented `Auto Injection` remains visible.
- Presets no longer enable or advertise the inert fields. `balanced`/`thorough` enable Auto Injection; `precise`/`lean` disable it.
- Retained the persisted schema fields at false defaults so existing config files continue to load. Type declarations mark them `@deprecated` and runtime continues to ignore them.
- Updated preset previews and `packages/compactor/README.md` to describe actual behavior.
- Updated config regression coverage to assert that reserved fields remain false in every preset and active Auto Injection behavior still differs by profile.

Validation: Compactor suite **90 passed**, root typecheck passed, and production build/secret scan passed.

### 3. Entire Compactor strategy sections were not enforced

**Status:** Staged truthful enforcement fixed on 2026-08-13  
**Original confidence:** Proven by reference  
**Impact before fix:** P1 security/expectation mismatch

The following persisted settings are not consumed by execution:

- `sessionContinuity.eventCategories`
- `fts5Index.chunkSize`
- `fts5Index.cacheTtlHours`
- `sandboxExecution.enabled`
- `sandboxExecution.mode`
- `sandboxExecution.allowedLanguages`
- `sandboxExecution.outputLimit`

Definitions are in `packages/compactor/src/config/schema.ts:25-40`. Sandbox tools register and execute unconditionally at `packages/compactor/src/tools/register.ts:192-248`. The executor uses its own hard-coded output and timeout defaults in `packages/compactor/src/executor/executor.ts:82-105`.

This means disabling sandbox execution or restricting languages in settings has no effect.

**Proof (2026-08-13):**

- `rg` for `eventCategories`, `chunkSize`, `cacheTtlHours`, `allowedLanguages`, `outputLimit`, `sandboxExecution`, `fts5Index`, `sessionContinuity` over `packages/compactor/src` returns zero hits outside `types.ts`, `config/schema.ts`, `config/manager.ts` (merge), `config/presets.ts`, and `tui/settings-overlay.ts`.
- `tools/register.ts:192-248` registers `sandbox`/`sandbox_file`/`sandbox_batch` unconditionally; its only config reads are `customNoisePatterns` (`:167`) and `autoCompaction` (`:312`).
- `PolyglotExecutor` hard-codes the output cap at `100 * 1024 * 1024` bytes (`executor.ts:87`) and the timeout at `30_000` ms (`executor.ts:106`); languages come from capability-based `detectRuntimes()` (`executor.ts:89`), never from `allowedLanguages`.
- The built bundle contains these fields only in schema/merge/preset/UI code (e.g. `bundled.js:3839` schema default, `3942` merge, `5578-5635` presets, `5801-5808` settings UI). Two presets even set `sandboxExecution: { enabled: false, mode: "off" }` (`bundled.js:5605,5635` / `config/presets.ts`) while the tools remain registered and callable.

**Resolution (Check → Fix → Test):**

With user approval, the contracts were narrowed to behavior that can be defined and tested without inventing policies:

- **FTS5:** project indexing had already moved to CocoIndex. Compactor now hides this legacy section and presets no longer alter it; fields remain loadable and deprecated for compatibility.
- **Session Continuity:** settings now gate both resume-row creation and hidden snapshot injection. `full` and `off` are the only UI modes. Legacy `essential-only` remains loadable and behaves as full; undefined `eventCategories` filtering is deprecated.
- **Sandbox:** tools and deprecated aliases are registered only when the section is enabled and mode is not off. `allowedLanguages` is checked before execution. A shared `PolyglotExecutor` now enforces configured `outputLimit` and project root. UI exposes only `all`/`off`; legacy `safe-only` remains loadable and behaves as enabled/all rather than falsely claiming an undefined security policy. Settings affecting registration require session reload.
- Negative regression tests verify no sandbox tools when off, rejection before executing a disabled language, configured output truncation, and continuity-off gating.

Validation: Compactor suite **94 passed**, root typecheck passed, and production build/secret scan passed.

### 4. Compactor display settings were entirely ineffective

**Status:** Fixed by hiding/deprecating the unsupported feature on 2026-08-13  
**Original confidence:** Proven by reference  
**Impact before fix:** P1/P2 user-visible no-op settings

`toolDisplay` defines `enabled`, `diffLayout`, `diffIndicator`, `showThinkingLabels`, `showUserMessageBox`, `showBashSpinner`, and `showPendingPreviews` in `packages/compactor/src/config/schema.ts:42-51`. Runtime construction at `packages/compactor/src/index.ts:542-552` only uses `mode`; it hard-codes:

- `previewLines: 20`
- `bashCollapsedLines: 5`
- `showTruncationHints: true`

The persisted top-level `showTruncationHints` is therefore ignored in this path.

**Proof (2026-08-13):**

- The only runtime `toolDisplay` reads are `const td = config.toolDisplay` and `td?.mode` at `packages/compactor/src/index.ts:544-548`. No other `toolDisplay.*` field is read outside `types.ts`, `config/schema.ts`, `config/presets.ts`, and `tui/settings-overlay.ts`.
- `enabled` is only get/set inside the settings UI (`settings-overlay.ts:146-147`); the runtime display path never checks it.
- Persisted `showTruncationHints` (`schema.ts:70`, merged at `manager.ts:122`) has no runtime consumer: the display path passes a literal `true` (`index.ts:551`), and even that value is never read — `applyToolDisplayOverride` declares `showTruncationHints?` in `ToolOverrideConfig` (`tool-overrides.ts:14`) but never uses it in its body.
- `diffLayout`, `diffIndicator`, `showThinkingLabels`, `showUserMessageBox`, `showBashSpinner`, `showPendingPreviews` have zero references outside config/types/UI.
- `ToolDisplayConfig` (`types.ts:241-266`, including `registerToolOverrides`, `enableNativeUserMessageBox`, `mcpOutputMode`, `diffWordWrap`, `showRtkCompactionHints`) is itself unreferenced (only its declaration), a dead exported type.
- Bundle counts are consistent with config/UI-only presence (`showTruncationHints` ×3 = schema default + manager merge + index literal; each other field ×1).

The unconditional context sanitizer at `packages/compactor/src/index.ts:599-607` also does not check `showThinkingLabels` or `toolDisplay.enabled`.

**Additional check:** the selectable `mode` was not effective either. Presets supplied `opencode`, `balanced`, `verbose`, or `custom`, while `applyToolDisplayOverride()` only recognizes per-tool modes such as `hidden`, `summary`, `preview`, `count`, and `full`. Every selectable profile therefore fell through to unchanged output. Implementing an inferred mapping would be risky because this hook replaces model-visible tool-result content, not merely TUI presentation.

**Resolution (Check → Fix → Test):**

- With user approval, removed Tool Display from settings and preset descriptions rather than inventing context-changing semantics.
- Presets no longer alter the legacy `toolDisplay` object.
- Removed the ineffective tool-result override call and hard-coded display config from `index.ts`.
- Retained `toolDisplay` and `showTruncationHints` as deprecated ignored config fields so existing files continue to load.
- Preserved unconditional narrow-terminal diff clamping and context sanitization; these are independent active safety behaviors.
- Left renderer modules for the later production-graph/API cleanup decision rather than deleting possible deep-import surfaces here.
- Added regression coverage asserting presets leave deprecated display compatibility data at defaults.

Validation: Compactor suite **95 passed**, root typecheck passed, and production build/secret scan passed.

### 5. Subagent per-type disable settings did not disable types

**Status:** Fixed on 2026-08-13  
**Original confidence:** Proven by reference  
**Impact before fix:** P1 policy mismatch

`SubagentsConfig.types[name].enabled` is merged by `packages/subagents/src/config.ts:119-125`, but consumed only to render `[disabled]` text in `packages/subagents/src/index.ts:338-367`. `AgentManager.spawn()` and `getAgentConfig()` do not reject disabled types.

Custom-agent frontmatter `enabled: false` is parsed in `packages/subagents/src/custom-agents.ts:76`, but is likewise not enforced.

**Proof (2026-08-13):**

- `config.types` is read in exactly one place, the info-screen data provider (`packages/subagents/src/index.ts:338-367`); `isEnabled = types[t]?.enabled !== false` (`:356`) only affects the `[disabled]` suffix in the displayed type list.
- Neither `AgentManager` (`agent-manager.ts`) nor `runAgent` (`agent-runner.ts`) contains any reference to `enabled`; `getAgentConfig()` (`agent-manager.ts:73-75`) returns the custom or built-in config unconditionally.
- The `spawn_helper` execute path calls `manager.spawn(...)` / `manager.spawnAndWait(...)` directly (`index.ts:654`, `index.ts:728-731`) with no enablement gate, so a type displayed as `[disabled]` can still be launched.
- Only the top-level `config.enabled` flag is enforced (`index.ts:129`), which disables the entire extension.

**Resolution (Check → Fix → Test):**

With user approval, enablement uses an AND rule: a type can spawn only when merged JSON `types[name].enabled` is not false **and** its resolved custom-agent frontmatter `enabled` is not false. Thus JSON can disable built-in or custom types, while JSON cannot accidentally override a custom file’s self-disable. Unmentioned types and internal `name-gen` remain enabled.

`AgentManager.spawn()` now rejects disabled types before allocating an ID, record, queue entry, or model request, covering foreground and background paths consistently. Tool guidance lists only currently enabled public types. Configuration remains startup-scoped, so reload is required after changing files; already-running agents are not killed.

Regression tests cover JSON-disabled built-ins, foreground/background rejection, no ghost records, custom self-disable precedence, JSON disabling an enabled custom agent, and default-enabled built-in/internal types.

Validation: Subagents suite **66 passed**, root typecheck passed, and production build/secret scan passed.

### 6. `notify_user.priority` was discarded

**Status:** Fixed on 2026-08-13  
**Original confidence:** Proven by reference  
**Impact before fix:** P2 misleading API

The public schema accepts priority in `packages/notify/tools.ts:15-23`. Execution destructures it as `_priority` at `packages/notify/tools.ts:49-54` and never passes it to dispatch.

**Proof (2026-08-13):**

- `dispatchNotification` has no priority parameter at all — signature is `(pi, title, message, eventPlatforms, eventType, config, cwd)` at `packages/notify/events.ts:166-173` — so the tool priority cannot structurally reach dispatch.
- The tool call site passes exactly those seven arguments (`tools.ts:64`); `_priority` is never referenced again.
- Platform priorities are sourced only from persistent configuration: Gotify from `config.gotify.priority` (`events.ts:256` → `platforms/gotify.ts:14,26`), ntfy from `ntfyConfig.priority` (`events.ts:281` → `platforms/ntfy.ts:15,35`). Telegram, native, and focus platforms have no priority handling.
- The only occurrence of the `"low" | "normal" | "high"` enum type is the tool schema (`types.ts:99`); no code maps it to the numeric priorities used by Gotify/ntfy.
- The schema even declares `default: "normal"`, a default with zero effect.

**Resolution (Check → Fix → Test):**

The README already advertised explicit priority, so the public input was retained and implemented with user-approved mappings:

- Gotify: `low=2`, `normal=5`, `high=8` on UniPi’s validated 1–10 scale.
- ntfy: `low=2`, `normal=3`, `high=5` on ntfy’s 1–5 scale.
- Native and Telegram have no corresponding input and ignore semantic priority.

The schema no longer supplies a `normal` default: omission is distinguishable and preserves each platform’s configured numeric priority. Explicit priority is threaded only through agent-tool dispatch; lifecycle/event notifications continue using configured values. Dispatch results include effective numeric priority for supporting platforms, and immediate tool details report requested/mapped values without waiting for fire-and-forget delivery.

Regression tests cover all six mappings. Validation: Notify tests **20 passed**, root typecheck passed, and production build/secret scan passed.

### 7. Milestone workflow-end hook was a no-op

**Status:** Fixed on 2026-08-13  
**Original confidence:** Proven by reference and installed SDK types  
**Impact before fix:** P2 missing synchronization

`packages/milestone/hooks.ts:138-140` says the hook listens for `WORKFLOW_END`. Actual wiring adds an `input` listener that always returns `undefined` at `packages/milestone/hooks.ts:170-176`; the callback does not inspect `event` or synchronize anything. The only implemented synchronization path is `session_shutdown` (`:182-207`).

**Proof (2026-08-13):**

- Exact repository search finds no `pi.events.on(UNIPI_EVENTS.WORKFLOW_END, ...)` in Milestone. `packages/milestone/index.ts:15-17` merely calls `registerSessionEndHook()`.
- The installed Pi SDK explicitly exposes `ExtensionAPI.events: EventBus` at `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:970`; `EventBus.on(channel, handler)` is declared in `dist/core/event-bus.d.ts:1-4`. The comment at `milestone/hooks.ts:179-181` claiming the API does not expose `pi.events.on()` is therefore false.
- Existing compiled source proves practical availability: Footer subscribes to `WORKFLOW_END` with `pi.events.on()` at `packages/footer/src/events.ts:212-218`; Notify subscribes non-lifecycle hooks through `pi.events.on(def.hook, handler)` at `packages/notify/events.ts:88-109`, including its `workflow_end` mapping (`:63`).
- Separate exact search finds **no emitter** of `UNIPI_EVENTS.WORKFLOW_END` or literal `unipi:workflow:end` anywhere outside the declaration/configuration/listener references. `packages/workflow` emits only `MODULE_READY` (`workflow/index.ts:128`), so Footer/Notify listeners cannot fire either.
- The production bundle corroborates this: the literal appears in the event constant, Notify mapping, and Footer listener, but no `events.emit` path.

Thus there are two independently proven gaps: Milestone never subscribes, and Workflow never emits the event it and other modules expect.

**Resolution (Check → Fix → Test):**

With user approval, Workflow now owns a single-active lifecycle tied to Pi’s real execution boundary:

- Slash handlers atomically start a lifecycle and emit `WORKFLOW_START` before enqueueing the workflow follow-up message. A second workflow command is rejected while one is active rather than overwriting state.
- The next `agent_end`—the same boundary already used to restore sandbox tools—emits exactly one `WORKFLOW_END` with command, arguments, duration, and best-effort success (`error`/`aborted` assistant stop reasons are false). Ordinary agent loops emit nothing.
- `/unipi:ralph-start` remains outside this contract because Ralph has its own lifecycle events.
- Milestone removed the no-op `input` callback and false SDK comment, subscribes through `pi.events.on(WORKFLOW_END)`, and runs its existing exact-match modified-doc synchronization immediately. Session shutdown remains a fallback for out-of-workflow changes.
- Existing Footer and Notify listeners now receive the lifecycle they already documented; enabled workflow-end notifications may therefore begin firing.

`WorkflowLifecycle` regression tests cover overlap rejection, one-shot completion, duration, success/failure, ordinary-loop silence, and reset. Validation: Workflow lifecycle **3 tests passed**, Milestone **24 tests passed**, root typecheck passed, and production build/secret scan passed.

### 8. Compactor resume and auto-injection output was computed but not injected into the model

**Status:** Fixed on 2026-08-13  
**Original confidence:** Proven by control-flow trace and installed SDK contract  
**Impact before fix:** P1 advertised compaction-survival feature was ineffective; repeated DB/debug work

At `packages/compactor/src/index.ts:281-298`, `injectResumeSnapshot()` returns a string to the local `snapshot`, then the callback does not return it, mutate the agent-start event, or send a message. It separately calls `buildAutoInjection(events)` and only debug-logs token/length metadata.

**Proof (2026-08-13):**

- The entire path runs inside a `before_agent_start` handler (`index.ts:234`). Pi allows this handler to inject context only by returning `BeforeAgentStartEventResult` with `message` or `systemPrompt` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:768-772`). Working examples return `systemPrompt` in `milestone/hooks.ts:46-61` and `workflow/index.ts:74+`.
- Compactor’s handler returns nothing after `snapshot` is produced. The local has exactly two references: assignment (`index.ts:281`) and truthiness/debug checks (`:282,285`). Neither `snapshot` nor `autoInjection.text` reaches a supported result field.
- `injectResumeSnapshot()` does correctly construct `fullSnapshot`: it rebuilds a snapshot from DB events, conditionally appends `autoInjection`, marks the resume row consumed, and returns the string (`session/resume-inject.ts:15-36`). The caller discards that return value.
- The follow-up branch (`index.ts:284-297`) repeats event retrieval with limit 100, builds auto-injection again, and only logs `tokens`/`length` (`:291`). Its comment claiming “The model receives it as part of the session state restoration” is unsupported by any subsequent statement.
- `injectResumeSnapshot()` has one caller (`index.ts:281`); `buildAutoInjection()` has only the real builder call inside `resume-inject.ts:29` and the duplicate log-only call at `index.ts:289`. There is no alternate injection caller or test.
- The pre-compaction path stores a resume row (`index.ts:365-373`), and this discarded path marks it consumed (`resume-inject.ts:35`), so the data is not merely deferred to another turn.
- The generated bundle preserves the same control flow (`bundled.js:27985-28005,29358-29369`): returned `fullSnapshot` is assigned then discarded, while duplicate auto-injection only logs.

This disproves the narrower original comment that auto-injection was already “included in the resume snapshot context”: the helper includes it in a returned string, but no extension API injects that string into model context.

**Resolution (Check → Fix → Test):**

- Rechecked Pi’s installed SDK and runtime: normal compaction summaries were already converted to model-readable user context; only UniPi’s additional structured resume snapshot was lost.
- Added `buildResumeContextMessage()` in `packages/compactor/src/session/resume-inject.ts`. It returns the snapshot as a `display:false` custom message (`unipi-compactor-resume`) and deliberately returns no `systemPrompt` replacement.
- `packages/compactor/src/index.ts` now returns that result from `before_agent_start`; the duplicate log-only `buildAutoInjection()` path was removed. Auto-injection remains included exactly once by `injectResumeSnapshot()`.
- This preserves the stable system-prompt/history prefix for provider cache reuse. The hidden custom message is model-readable conversation context: it is inserted once on the first post-compaction request and remains in history until a later compaction summarizes/removes it.
- Regression tests in `packages/compactor/tests/resume-inject.test.ts` verify hidden-message delivery, no system-prompt mutation, snapshot content, and one-shot consumption.

Validation: Compactor suite **90 passed**, root typecheck passed, and production build/secret scan passed.

### 9. Compactor indexed-byte accounting could not run

**Status:** Removed on 2026-08-13  
**Original confidence:** Verified  
**Impact before fix:** P3 permanently-zero metric

`isIndexTool()` always returns false in `packages/compactor/src/index.ts:66-69`; therefore `runtimeStats.bytesIndexed` at `packages/compactor/src/index.ts:534-536` can never increment.

**Resolution (Check → Fix → Test):**

Rechecked current ownership: project indexing belongs to CocoIndex, and no Compactor tool produces index-kept output. Compactor’s live `compactor_stats` path uses DB/counter statistics rather than the old `SessionAnalytics` report; wiring CocoIndex names into this metric would also be incorrect because cross-extension tool results are not content withheld by Compactor.

Removed the always-false `isIndexTool()` branch and `bytesIndexed` runtime field/reset/accounting. The legacy disconnected analytics implementation now calculates `keptOut` only from its real sandbox byte input. This is internal cleanup with no runtime output change because the removed value was permanently zero.

Validation: strict unused-symbol check shows no residual `bytesIndexed`/`isIndexTool` diagnostics or references, Compactor suite **95 passed**, root typecheck passed, and production build/secret scan passed.

---

## P1/P2: dormant event contracts

### 10. Module status request/response was disconnected

**Status:** Fixed by simplifying the command on 2026-08-13  
**Original confidence:** Proven by exhaustive source and bundle references  
**Impact before fix:** P2 misleading command and fixed 500 ms delay

Utility emits `MODULE_STATUS_REQUEST` at `packages/utility/src/commands.ts:239`. No module listens for it, and nothing emits or listens for `MODULE_STATUS_RESPONSE`, declared at `packages/core/events.ts:27-30`.

**Proof (2026-08-13):**

- An exhaustive symbolic-and-literal search across all project source finds only: the two constants and payload interfaces in `packages/core/events.ts:28-30,154-168`, plus the single request emission in `packages/utility/src/commands.ts:239`. There is no `events.on` request listener, no response emitter, and no response listener.
- The production bundle contains the same three operational occurrences only: constants at `bundled.js:343,345` and request emission at `:18247`. `MODULE_STATUS_RESPONSE` occurs once in the bundle, its constant declaration; there is no bundle `events.emit`/`events.on` call for either status channel.
- The installed Pi EventBus is synchronous at emission (`dist/core/event-bus.js:5-7` calls Node `EventEmitter.emit`). With no listener, the request is discarded immediately.
- The command nevertheless waits 500 ms unconditionally (`utility/src/commands.ts:241-242`) and then sends a static response claiming modules “will respond via events” (`:244-250`). It never registers a response listener or aggregates response payloads, so even adding module responders alone would not make the command display their status.
- The advertised command description says “Show all unipi modules status” (`utility/src/commands.ts:228`, `packages/utility/README.md:13`), but the output contains only a generated request ID.

**Resolution (Check → Fix → Test):**

A complete responder protocol would require 15+ modules to define and maintain status schemas, aggregation, duplicate/error handling, and timeout semantics despite UniPi already having canonical surfaces: `/unipi:info` for live registered module/tool information and `/unipi:doctor` for diagnostics.

With user approval, `/unipi:status` was simplified to respond immediately with guidance to those commands. Removed the discarded request emission, unconditional 500 ms delay, meaningless request ID, and false response claim. Public `MODULE_STATUS_REQUEST`/`RESPONSE` constants and payload interfaces remain exported but are marked deprecated for compatibility pending the broader dormant-event review.

Regression coverage asserts the status command contains both canonical destinations and no request, timeout, or request ID. Validation: Utility status **1 test passed**, root typecheck passed, and production build/secret scan passed.

### 11. Proven event matrix: dormant and one-sided contracts

**Status:** Staged repair completed on 2026-08-13  
**Original confidence:** Proven by exhaustive symbolic/literal source search and bundle counts  
**Impact before fix:** P2 stale contracts, inert listeners, and misleading integration comments

The matrix below distinguishes four materially different cases. Searches excluded tests and included every production TypeScript file; the generated bundle was checked separately. Indirect Notify subscriptions were traced through `BUILTIN_EVENTS` and `registerEventListeners()`.

#### Neither emitted nor listened to

| Event | Declaration | Production refs outside Core | Bundle result |
|---|---|---:|---:|
| `MODULE_GONE` | `core/events.ts:13` | 0 | constant only |
| `MEMORY_SEARCHED` | `core/events.ts:42` | 0 | constant only |
| `UTILITY_CLEANUP_START` | `core/events.ts:64` | 0 | constant only |
| `UTILITY_CACHE_INVALIDATED` | `core/events.ts:72` | 0 | constant only |
| `UTILITY_LIFECYCLE_STATE` | `core/events.ts:74` | 0 | constant only |
| `COCOINDEX_UPDATE_STARTED` | `core/events.ts:95` | 0 | constant only |
| `COCOINDEX_UPDATE_COMPLETED` | `core/events.ts:97` | 0 | constant only |
| `COCOINDEX_SEARCH_PERFORMED` | `core/events.ts:99` | 0 | constant only |

`MODULE_STATUS_RESPONSE` is also in this category and is proven separately in §10.

#### Listened to but never emitted

| Event | Listener | Proof of missing emitter |
|---|---|---|
| `COMPACTOR_COMPACTED` | Footer `footer/src/events.ts:40` | exact search finds only declaration + listener |
| `COMPACTOR_STATS_UPDATED` | Footer `footer/src/events.ts:30` | exact search finds only declaration + listener |
| `RALPH_ITERATION_DONE` | Footer `footer/src/events.ts:189` | exact search finds only declaration + listener |

Consequences are concrete: Footer’s Compactor event cache cannot update from these channels, and its Ralph iteration display cannot receive per-iteration updates.

#### Emitted but not listened to inside UniPi

| Event | Emitter |
|---|---|
| `UTILITY_CLEANUP_DONE` | `utility/src/commands.ts:268` |
| `UTILITY_DIAGNOSTICS_START` | `utility/src/commands.ts:309` |
| `UTILITY_DIAGNOSTICS_DONE` | `utility/src/commands.ts:316` |
| `INFO_DATA_UPDATED` | Updater `updater/src/index.ts:95,105,115` |
| `NOTIFICATION_SENT` | Notify `notify/events.ts:222` |
| `MCP_TOOLS_REGISTERED` | `mcp/src/bridge/registry.ts:146` |
| `MCP_TOOLS_UNREGISTERED` | `mcp/src/bridge/registry.ts:192` |
| `MCP_CATALOG_SYNCED` | `mcp/src/index.ts:227` |

These may be intentional third-party extension points, so they are one-sided rather than proven useless. Their current effect inside the bundled suite is none.

#### Correctly wired or conditionally wired — earlier hypotheses disproven

- **Ralph does emit documented lifecycle events:** `RALPH_LOOP_START` at `ralph/ralph-loop.ts:327`; `RALPH_LOOP_END` at `:154,173`. Footer listens at `footer/src/events.ts:169,179`, and Notify indirectly subscribes to loop-end via `notify/events.ts:64,88-109`. The hypothesis that Ralph emits none of its documented events is **disproven**; only `RALPH_ITERATION_DONE` is missing.
- `ASK_USER_PROMPT` is conditionally emitted when `settings.notifyOnAsk` is enabled (`ask-user/tools.ts:263-272`) and Notify subscribes indirectly through `BUILTIN_EVENTS` (`notify/events.ts:68,88-109`).
- MCP server lifecycle is substantially wired: emitters at `mcp/src/bridge/registry.ts:141,172,218`; Footer listeners for started/stopped/error at `footer/src/events.ts:88,104,120`; Notify additionally listens to server error through its mapping (`notify/events.ts:65,88-109`).

#### Why the classification is proven

- For each named constant, both symbolic name and literal channel were searched across production TypeScript.
- Bundle symbol counts match the source classification: dormant events occur once (constant only); listener-only events occur twice (constant + listener); emitter-only events occur twice or more according to their emit sites.
- Mapped subscriptions were not inferred from simple name counts: Notify’s event table and generic `pi.events.on(def.hook, handler)` loop were read directly.

**Resolution (Check → Fix → Test):**

Revalidation corrected one stale classification: `NOTIFICATION_SENT` is currently emitted by Notify and consumed by Footer. Emitter-only channels are retained as external extension points rather than labeled useless solely because the bundled suite lacks consumers.

With user approval, the repair was limited to contracts with defined semantics:

- Compactor now emits `COMPACTOR_COMPACTED` once after `session_compact` accounting. Payload includes session, summarized count, estimated kept/tokens saved, and the same 12%-based estimated compression used by existing analytics.
- Ralph now emits `RALPH_ITERATION_DONE` only after a successful `advanceIteration()`, with completed and next iteration; max-limit completion does not falsely emit advancement.
- Removed Footer’s stale `COMPACTOR_STATS_UPDATED` listener and corrected docs because current Compactor segments read live Pi session data directly. The public constant/interface remain deprecated compatibility exports.
- Declaration-only module/memory/utility/CocoIndex constants remain exported but are marked deprecated/reserved rather than removed or assigned speculative emit points. Status events were already deprecated in §10.
- Emitter-only Utility/Updater/MCP channels remain available as external integration hooks. No invented bundled listeners were added.

Event-contract tests assert Compactor and Ralph emitter/listener pairs and absence of the stale stats listener. Validation: event contracts **3 passed**, Footer suite **51 passed**, root typecheck passed, and production build/secret scan passed.

---

## P1/P2: entry-point and packaging problems

### 13. Standalone Subagents package was unimportable

**Status:** Fixed on 2026-08-13  
**Original confidence:** Proven with actual tarball and isolated install  
**Impact before fix:** P1 standalone package defect

`packages/subagents/package.json:6-12` points `main`, `types`, and `exports` to `dist/index.*`, but publication does not create those files.

**Proof (2026-08-13):**

- `packages/subagents/dist` is absent in the workspace.
- `npm pack ./packages/subagents --dry-run --json` lists 22 files with `hasDist:false`, `hasMain:false`, and `hasTypes:false`. It includes raw `src/*.ts` and all six `src/__tests__/*.test.ts` files.
- A real tarball was created, installed into an empty temporary project with peers omitted, and imported by package name. Node failed exactly as expected: `ERR_MODULE_NOT_FOUND: Cannot find module '<temp>/node_modules/@pi-unipi/subagents/dist/index.js'`.
- The package defines `build: tsc` but no `prepare`, `prepack`, or `prepublishOnly` hook, and has no `files` allowlist. The umbrella hides the defect by importing source directly at `packages/unipi/index.ts:18`.

**Resolution (Check → Fix → Test):**

With user approval, the already-declared built ESM contract was made real rather than weakening `main`/`exports` to raw TypeScript:

- Added a production-only `tsconfig.build.json` excluding tests, a local global-registry declaration, clean/noEmitOnError build, and build verification.
- Added `prepack` so every tarball regenerates verified `dist/index.js` and declarations.
- Narrowed publication to `dist/**` and README; raw source/tests are no longer shipped.
- Added standalone Pi metadata loading `./dist/index.js`.
- Removed unused runtime dependencies on Workflow/Info Screen/Core. Subagents now keeps its tiny event compatibility shim locally, avoiding a second standalone failure caused by Core’s current raw-TS package entry. External event channel strings/payload remain unchanged.
- Added `scripts/test-subagents-tarball.mjs`: creates the real tarball, verifies entries/no tests/src, installs it in an empty temporary project, imports by package name in plain Node, checks default export and Pi metadata, and cleans up.

Validation: tarball smoke passed (**50 files**), Subagents suite **66 passed**, root typecheck passed, and production build/secret scan passed.

### 14. Root wrappers were disconnected from package mains

**Status:** Resolved on 2026-08-13  
**Original confidence:** High-confidence candidate

These wrappers are bypassed because package `main` points to `src/index.ts`:

- `packages/autocomplete/index.ts`
- `packages/footer/index.ts`
- `packages/image/index.ts`
- `packages/input-shortcuts/index.ts`
- `packages/mcp/index.ts`
- `packages/updater/index.ts`
- `packages/utility/index.ts`

`packages/compactor/index.ts` is not dead: standalone Compactor Pi metadata explicitly loads it.

Some disconnected wrappers export additional types, so they may represent an intended public barrel rather than deletion candidates.

**Resolution (Check → Fix → Test):**

Git history confirmed the wrappers were introduced as barrels, then a later bulk package-resolution fix set every `main` directly to `src/index.ts`. Current classification showed five wrappers were exact default-only pass-throughs with no additional API, while Footer and Updater intentionally exported named public types.

With user approval:

- Removed redundant wrappers for Autocomplete, Image, Input Shortcuts, MCP, and Utility. Their existing `src/index.ts` mains and default runtime APIs are unchanged; Input Shortcuts also loses its problematic `.ts` re-export specifier.
- Restored Footer and Updater `main: "index.ts"`, preserving default exports while making intended named type barrels canonical.
- Added missing `types.ts` to Updater’s publication allowlist so the now-canonical barrel is complete in its tarball.
- Added `scripts/test-package-entries.mjs`, asserting each main exists, only meaningful barrels remain, and those barrels are canonical.

Validation: package-entry contracts passed, Updater barrel tarball manifest passed, Updater **10 tests passed**, root typecheck passed, and production build/secret scan passed.

### 15. Test sources were proven to ship

**Status:** Fixed on 2026-08-13  
**Original confidence:** Proven with tarball manifests  
**Impact before fix:** P3 package bloat and accidental implementation exposure

Root `package.json:33-44` includes `packages/*/src/**/*.ts`, which captures source-tree tests. `npm pack . --dry-run --json` produced a 379-file tarball manifest containing 11 test files: two Autocomplete tests, three Notify tests, and all six Subagents tests. The standalone Subagents tarball independently contains those same six tests because it lacks a `files` allowlist.

**Resolution (Check → Fix → Test):**

Fresh manifests after F12/F13 showed the root still shipped **15** test files (new focused regression tests included). Four standalone workspace tarballs also shipped tests: Autocomplete (2), Core (1), Utility (1), and Workflow (1). Subagents was already corrected by its dist-only publication.

Added npm negated publication patterns at both scopes:

- Root excludes all package `tests/`, `__tests__/`, `*.test.ts`, and `*.spec.ts` while retaining runtime TypeScript, skills, package metadata, and the bundled extension.
- Autocomplete, Core, Utility, and Workflow apply corresponding narrow exclusions in their own manifests.

Added `scripts/test-tarball-manifests.mjs`. It dry-runs the root and every workspace package, rejects test directories/files, asserts root bundle/package metadata, and verifies each workspace README/package metadata and declared main are present. This avoids accidentally fixing bloat by dropping runtime files.

Validation: manifest assertions passed for root plus **22 package directories**, root typecheck passed, and production build/secret scan passed.

### 16. Runtime dependency contracts: two disproven, two proven Utility defects

**Status:** Utility defects fixed on 2026-08-13  
**Original confidence:** Proven with manifests and isolated installs

The initial broad dependency hypothesis was partly wrong:

- **Disproven:** CocoIndex does declare `@lancedb/lancedb` under `optionalDependencies` (`packages/cocoindex/package.json`), matching its dynamic import at `bridge.ts:456`.
- **Disproven:** Compactor does declare `better-sqlite3` under `optionalDependencies` (`packages/compactor/package.json`), matching its dynamic DB loading. An isolated install with `--omit=optional` correctly left both unavailable; that is expected optional-feature behavior, not an undeclared dependency.
- **Proven Utility defect:** Utility imports `shiki` directly (`utility/src/diff/highlighter.ts:252,265`) but declares only `@shikijs/cli`. In an isolated nested install, `@shikijs/cli` resolved and its private nested `shiki` appeared in `npm ls`, while `createRequire()` from Utility source returned `MODULE_NOT_FOUND` for `shiki`. Node does not resolve a dependency’s private nested dependency as its parent’s direct import. Highlighter catches this error and silently falls back to plain text, so advertised Shiki highlighting is disabled in a strict install.
- **Proven Utility defect:** Utility imports runtime values from `@earendil-works/pi-tui` in renderer/wrapper/TUI modules but does not declare it as dependency or peer. The same isolated resolution returned `MODULE_NOT_FOUND`. Loading those eager modules can therefore fail rather than degrade gracefully.

The root/monorepo install masks both Utility defects through hoisting and the umbrella package’s peer graph.

**Resolution (Check → Fix → Test):**

The CocoIndex and Compactor findings remain disproven/expected optional behavior. With user approval, Utility’s two proven manifest defects were corrected:

- Replaced unused `@shikijs/cli` with direct `shiki:^4.0.2`, matching the actual dynamic API/type imports. Existing graceful fallback remains for genuine Shiki initialization failures.
- Added `@earendil-works/pi-tui:^0.80.0` as a peer dependency, matching the suite’s host-shared Pi TUI policy and Utility’s eager runtime imports.
- Regenerated the lockfile.
- Added `scripts/test-utility-tarball.mjs`: creates and installs the real Utility tarball in an empty project, reads its installed manifest, rejects CLI reliance, asserts direct Shiki and TUI peer declarations, and resolves both from Utility’s own package root.

Validation: isolated Utility dependency resolution passed, Utility suite **180 passed**, root + **22** package manifests passed, root typecheck passed, and production build/secret scan passed.

---

## Proven dead private symbols

**Status:** Removed on 2026-08-13  
**Original confidence:** Proven by TypeScript scope analysis, exact references, and bundle tree-shaking

Running TypeScript with `--noUnusedLocals --noUnusedParameters` reports each declaration below as TS6133. Exact scoped searches show no value read, and the production bundle either erases the declaration or preserves it without a caller:

- `renderTimeSegment` — `packages/footer/src/segments/core.ts:222` (one source hit; erased from bundle)
- `findAlternateLinks` — `packages/web-api/src/engine/extract.ts:202` (one source hit; erased)
- `removeCorruptedDb` — `packages/memory/storage.ts:460` (one source hit; unused private method remains in class bundle)
- `HARDCODED_FALLBACK` — `packages/utility/src/diff/theme.ts:105` (one source hit; unused constant remains in bundle)
- local `getPackageVersion` — `packages/info-screen/core-groups.ts:20` (TS6133; distinct from used Core helper)
- Subagents widget `formatTokens` — `packages/subagents/src/widget.ts:55` (TS6133; distinct from similarly named used helpers)
- Utility name-badge `padVisible` — `packages/utility/src/tui/name-badge.ts:19` (TS6133; other modules have independent used functions with the same name)
- old `selectProvider` — `packages/web-api/src/tools.ts:70` (TS6133; only an obsolete comment in Wigolo mentions it; runtime uses exported `selectProviderChain`)
- CocoIndex `jsonResult` — `packages/cocoindex/tools.ts:38` (TS6133; distinct from Compactor’s used local function)

The same compiler pass disproves a naïve global-name approach: `jsonResult`, `padVisible`, `formatTokens`, and `getPackageVersion` have valid uses in other lexical scopes. Only the declarations/files above are dead.

**Resolution (Check → Fix → Test):**

Re-ran strict TypeScript unused analysis and exact scoped references after all prior changes. All nine declarations remained TS6133 private/local one-hit symbols and none was exported. Removed exactly those declarations plus `MAX_ALTERNATE_LINKS`, which existed solely for removed `findAlternateLinks`; did not remove same-named helpers in other scopes. This is behavior-neutral because no call/read path existed.

Post-removal strict diagnostics contain none of the nine symbols. Validation: Footer **52 passed**; Web API **44 passed, 3 skipped**; Utility **180 passed**; Subagents **66 passed**; Memory has no package tests; CocoIndex has no tests and its package typecheck passed. Root typecheck passed and production build/secret scan passed.

---

## Production-graph-disconnected source files

**Status:** Conservatively removed on 2026-08-13 with explicit approval  
**Original confidence:** Proven absent from the shipped umbrella graph; external deep-import use remained unknowable

A fresh esbuild metafile was generated from the real production entry `packages/unipi/index.ts` using the same policy as `scripts/build-bundle.mjs` (relative and `@pi-unipi/*` imports bundled; third parties external). The graph contains 249 inputs and emits a 1,282,123-byte bundle. Each file below is absent from that graph.

### Proven unused imports that explain graph exclusion

- `packages/memory/search.ts` is imported only as unused `hybridSearch` in `memory/tools.ts:18`; TypeScript reports that import TS6133, so esbuild removes it.
- `packages/kanboard/tui/kanboard-overlay.ts` is imported only as unused `renderKanboardOverlay` in `kanboard/commands.ts:12`; TypeScript reports TS6133 and esbuild removes it.

These files are not runtime-reachable through the shipped umbrella despite source imports appearing to connect them.

### No production imports and absent from graph

- `packages/input-shortcuts/src/status.ts`
- `packages/milestone/coexist.ts`
- `packages/subagents/src/prompts.ts`
- `packages/web-api/src/tui/progress.ts`
- `packages/web-api/src/tui/result.ts`
- `packages/compactor/src/compaction/recall-scope.ts`
- `packages/compactor/src/display/bash-display.ts`
- `packages/compactor/src/display/diff-presentation.ts`
- `packages/compactor/src/display/pending-diff-preview.ts`
- `packages/compactor/src/display/user-message-box.ts`

Each exports implementation code but has zero production import specifiers.

### Type-only modules, not runtime deletion evidence

- `packages/compactor/src/compaction/sections.ts` is absent because `SectionData` is imported/re-exported only as a type (`format.ts:5`, `build-sections.ts:12-13`).
- `packages/compactor/src/session/analytics.ts` is absent from runtime despite `RuntimeStats` type use in `index.ts:26,87`; its runtime `SessionAnalytics` implementation is unimported, but the file also supplies a live compile-time type.

These should not be described as wholly dead without first relocating their live types.

### Resolution (Check → Fix → Test)

A fresh post-fix metafile still contained **252 production inputs** and all 14 candidates remained absent. None of the candidate APIs was documented or exported from package roots. Most raw-TypeScript package tarballs technically permitted undocumented deep imports because they lack exports maps, so deletion was correctly treated as compatibility-sensitive and explicitly approved.

Implemented the conservative deletion:

- Removed Memory’s unused `hybridSearch` import and deleted `memory/search.ts`; active `MemoryStorage.search()` behavior is unchanged.
- Removed Kanboard’s unused overlay import and deleted the never-invoked TUI overlay; active web-server Kanboard behavior is unchanged.
- Deleted zero-production-import Input Shortcuts status, Milestone coexist, Subagents prompts, Web API TUI progress/result, and five legacy Compactor recall/display modules.
- Preserved live type contracts before deleting mixed Compactor files: active compaction imports now use the existing canonical `SectionData` in `src/types.ts`; moved `RuntimeStats` to that active type module. Deleted disconnected `sections.ts` and analytics runtime implementation only afterward.
- Added `scripts/test-production-graph.mjs`, which asserts all 14 retired files remain absent and rebuilds the real umbrella graph under production externalization policy.

Validation: graph contract passed (**252 inputs, 14 retired modules**); Compactor **95 passed**; Input Shortcuts **19 passed**; Milestone **23 passed**; Subagents **66 passed**; Web API **44 passed, 3 skipped**. Kanboard has no package tests. Root typecheck, all tarball manifests, and production build/secret scan passed.

### Candidates removed from the proven list

The earlier Kanboard component candidates (`ui/components/checklist.ts`, `copy-button.ts`, `status-badge.ts`) were not promoted to proven dead in this pass; generated HTML/browser references and public deep imports require separate proof.

Because workspace packages publish raw source and generally lack restrictive `exports` maps, graph absence proves **shipped umbrella runtime disconnection**, not absence of every possible external deep import. Cleanup should establish public API boundaries first.

---

## Items deliberately not classified as dead

- Type-only modules omitted by esbuild.
- Utility helpers documented as programmatic deep-import APIs, including batch, TTL-cache, capabilities, and width helpers.
- Test-support modules with dedicated tests.
- Browser-global functions referenced from generated HTML/Alpine attributes.
- Compatibility aliases such as `vcc_recall`, `ctx_execute`, and `ctx_stats`; these are maintenance debt, but intentional until a deprecation deadline is chosen.
- `packages/unipi/bundled.js`; it is the actual shipped Pi extension and exists for startup performance.
- Framework callbacks with unused parameters.

---

## Remaining follow-up

1. Resolve or unregister the deferred LLM summarization placeholder only after the planned Wigolo/web-fetch architecture decision.
2. Plan removal of retained deprecated compatibility fields/events under an explicit major-version policy if desired.
3. Consider broader package `exports` boundaries separately; this repair removed only explicitly approved undocumented deep-import candidates and did not impose suite-wide exports restrictions.

## Final validation status

- `npm run typecheck` — passed.
- `npm test` — passed across the root and every workspace with a test script.
- `npm run build` — passed; generated bundle secret scan clean.
- `git diff --check` — passed after removing two trailing spaces in previously edited Subagents lines.
- `scripts/test-package-entries.mjs` — passed.
- `scripts/test-production-graph.mjs` — passed (**252 inputs, 14 retired modules**).
- `scripts/test-subagents-tarball.mjs` — passed (**46-file** final tarball after graph cleanup).
- `scripts/test-utility-tarball.mjs` — passed.
- `scripts/test-tarball-manifests.mjs` — passed for root plus **22 package directories**.
- Strict unused-symbol recheck no longer reports any of the nine removed scoped declarations; unrelated compiler diagnostics were not broadened into speculative cleanup.
