# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.14.2] — 2026-08-31

### Fixed

- `footer`: **glance frame no longer writes the terminal's last column** (GitHub [#31](https://github.com/Neuron-Mr-White/UniPi/issues/31)) — the glance frame, session strip, process one-liner, and classic status line now cap emitted lines at `width - 1` instead of exactly `width`. pi-tui joins per-tick rewrites with `\r\n`; a line at EXACTLY the terminal width trips auto-wrap on terminals that wrap immediately (or whose glyph widths disagree with `visibleWidth()`, e.g. missing Nerd Fonts / ambiguous-width settings), silently desyncing the differential renderer so every 1s footer refresh painted a fresh input-box copy one block lower until the screen filled. Verified by PTY capture + VT replay: identical byte stream renders 1 stable frame on deferred-wrap terminals vs 12 stacked frames on immediate-wrap ones; the cap removes the footer's contribution entirely. Full resolution of terminal-side drift from pi's own boot/info lines is upstream (pi-tui main-screen wrap-safe bookkeeping).
- `web-api`: **fetch errors surface their real cause instead of "[object Object]"** — engine errors were plain objects (`{ error, code, phase, retryable }`), so every tool-level catch serialized them via `String()` and both the agent and the user saw only "Read failed: [object Object]" with no diagnosis. `createError()` now returns a real `Error` instance carrying the FetchError fields (interface-compatible: `.error`/`.code`/`.phase`/`.retryable` preserved, classification untouched), and a new `describeError()` normalizes Error instances, FetchError-shaped objects, `{message}`/`{reason}`/`{detail}` shapes, strings, and unserializable values at every tool boundary and in the provider fallthrough. Regression tests cover all shapes; a provider throwing `{ error: "HTTP 429" }` now reports the 429 instead of nothing.

## [2.14.1] — 2026-08-28

### Added

- `utility`: **skill startup discovery toggle** (`/unipi:skills-settings`, default on) — controls whether Unipi's built-in skills are cataloged in the agent's system prompt at startup. When off (`unipi.skills.discovery: false` in pi settings.json), Unipi's bundled skills are removed from the `<available_skills>` section every turn while user-owned skills (global, project, settings-mounted, third-party packages) stay cataloged; `/skill:name` invocation keeps working since pi expands those commands by reading SKILL.md directly from disk. Filtering is anchor-based (agentskills.io tags) and applied consistently per turn, preserving provider prefix cache.
- `autocomplete`: registered `/unipi:skills-settings` in COMMAND_REGISTRY + COMMAND_DESCRIPTIONS so the command autosuggests.

### Fixed

- `info-screen`: **boot splash no longer eats keystrokes or strands the session** — the auto-close boot dashboard was a capturing overlay during its 2s window: typing during boot was swallowed (worse, its vim-style keys interpreted command text as tab switches), the first-keypress-cancels-auto-close rule left it on screen forever as an unclosable input-eating zombie, and prompts appeared to never send (the agent actually responded behind the overlay). The splash is now non-capturing (typing always reaches the editor) and dismisses itself via a stack-safe `handle.hide()` that only fires while it is the topmost visible overlay entry — if the user opens any dialog during the splash window (e.g. `/unipi:skills-settings`), dismissal defers until it closes, so the overlay can no longer be orphaned with a pending interaction (previously the covered overlay vanished while its `ctx.ui.select` promise hung forever). Interactive (`bootMode: "on"`) dashboards are unchanged; splash footer now reads "auto-dismissing…" instead of keyboard hints that could never reach it.

## [2.14.0] — 2026-08-29

### Changed

- `image`: **`image_recognize` is now hidden while the session model has vision** — a model that accepts image input reads images natively through pi's own read tool, so the separate recognition round-trip only duplicated the ability and burned system-prompt context. The extension drops the tool from the active set on `session_start` and `model_select` when the session model declares image input (`input` includes `"image"`), and restores it automatically when a text-only model takes over mid-session. Models that do not declare input modalities are treated as non-vision and keep the tool, matching the package's existing convention. The info screen shows "Hidden (model has vision)" for the Recognize stat while suppressed.

## [2.13.0] — 2026-08-28

### Added

- `footer`: **bg-process one-liner above the glance footer** — a centered strip directly above the frame showing live background-task counts with status dots: green ● running, yellow ● stopped (killed), red ● failed, gray ● done. Zero-count buckets are omitted and the line hides entirely when idle. Reads `BackgroundTaskRegistry.allTasks()` directly (no events, no polling channels) and re-renders on the footer's 1s refresh timer; counts reset per session.
- `background-tasks`: **shared registry accessor** (`getSharedTaskRegistry` / `setSharedTaskRegistry` / `clearSharedTaskRegistry` in `src/registry-shared.ts`) — lets sibling extensions read the live task registry synchronously. Stored on `globalThis` under a `Symbol.for` key so the singleton survives duplicate module instances; published at extension init and `session_start`, cleared on `session_shutdown`.

### Changed

- `footer`: new dependency on `@pi-unipi/background-tasks` for the process one-liner's direct registry reads.

## [2.12.0] — 2026-08-27

### Added

- `footer`: **Glance footer mode** (default on, toggle in `/unipi:footer-settings` → Appearance → "Glance Footer") — a framed input surface inspired by pi-glance. Top border shows a lolcat-animated UNIPI brand plus the git branch; bottom border carries workspace directory, context %/window, model, and thinking level; the whole frame flows with an animated rainbow gradient while thinking is max/xhigh.
- `footer`: **session strip** centered under the input — turns · steps | wall time · tool time | avg TTFT · tok/s | cache hit %, with per-stat coloring (tok/s tiered by speed, cache hit by hit rate).
- `footer`: restart-honest session statistics derived from persisted session entries (turns = user messages, steps = assistant messages, wall/tool/TTFT windows from entry timestamps), so numbers survive `pi -r` without live hook support. Live hooks still refine precision when available.
- `footer`: git branch adornments from a cached 2s porcelain probe — dirty `*`, ahead `↑N`, behind `↓N` on any preset showing the branch segment.
- `footer`: new default preset (UNIPI brand · model · thinking · directory · branch | context/tokens · tps · cost · clock) with the previous balanced layout preserved as the `classic` preset.
- `footer`: `uni` (brand mark) and `directory` segments, nerd/emoji/text icon entries for both.

### Changed

- `footer`: TPS token accounting anchored to provider-reported `usage.output` at stream end; density chars/4 estimate only fills streaming gaps. Timing windows measure output-only spans (first delta → stream end) so tool execution, queueing, and time-to-first-token no longer dilute rates. Session average clamps pathological reconstructed durations (600s) and prefers real next-entry deltas after restarts — tok/s stays truthful across sessions for any provider that reports usage.
- `footer`: TTFT measured per deepseek-harness semantics — agent turn start → first non-empty delta, averaged only over samples where both bounds exist; scan-derived seeds (clamped 30s) fill in when turn hooks are unavailable.

### Fixed

- `footer`: frozen/stale TPS after session resume or branch switch — streaming hooks and the reconciliation scan keyed tracker records with different index schemes; both now share a synchronized cursor (`cursorSyncCount`).
- `footer`: info dashboard unclosable when extensions replaced the editor during startup focus handoff — glance editor install is deferred past boot overlay auto-close, and settings-driven swaps wait until the settings overlay closes (`setEditorComponent` steals keyboard focus by design).
- `footer`: rainbow frame garbled zero-width IME cursor markers and OSC-133 zone sequences in max/xhigh thinking mode; the painter now passes all escape forms through byte-identical.

## [2.11.0] — 2026-08-26

### Added

- `trajectory`: full UniPi-owned package attribution for lifecycle hooks, command handlers, tool execution, mutating `ExtensionAPI` calls, context/session actions, and custom EventBus delivery, including duration, result fingerprints, errors, and bounded mutation evidence.
- `trajectory`: per-request prefix-integrity verdicts (`first_request`, `identical_retry`, `prefix_extended`, `boundary`, `violation`) over final serialized provider payloads. Violations identify the first changed message index/path and separately report system prompt, tool schema/order, provider route, thinking level, and envelope drift.
- `trajectory`: explicit cache epochs for compaction, tree navigation, model changes, and thinking-level changes; append-only enforcement resumes immediately after each boundary.
- `trajectory`: **UniPi** and **Violations** filters plus Trace, Integrity, and Attribution inspector tabs.

### Changed

- Umbrella `@pi-unipi/unipi` now loads every owned module through a package-scoped tracing API and keeps trajectory as the final unwrapped sink. Unrelated third-party extensions are intentionally excluded from attribution.
- Trajectory is now context-focused: the ledger includes provider-visible messages, system prompts, serialized requests, prefix verdicts, and only UniPi operations that mutate context or establish a cache epoch. Inert lifecycle hooks, registrations, notifications, response headers, and stream deltas are excluded.
- Trajectory live updates now cache the telemetry tail and projected snapshot, read only the last 5 MB of existing sidecars, use conditional 1.5-second polling, and avoid rerendering unchanged pages.

## [2.10.2] — 2026-08-25

Follow-up to 2.10.1: the 2.10.1 tarballs shipped with `@pi-unipi/*` cross-dependency pins still pointing at `2.10.0`, so installing `@pi-unipi/unipi@2.10.1` resolved the old `@pi-unipi/trajectory@2.10.0` (without the auto-completion fix) instead of `2.10.1`. This release re-synchronizes every cross-pin to `2.10.2` and republishes the full synchronized set.

### Fixed

- Resynced every `@pi-unipi/*` dependency pin (root umbrella + all workspace cross-deps) to the matching published version so npm links the workspace set instead of pulling nested stale registry copies. Without this, `@pi-unipi/unipi@2.10.1` pulled `@pi-unipi/trajectory@2.10.0` and the argument auto-completion fix never reached umbrella installers.

## [2.10.1] — 2026-08-25

Patch release: `/unipi:trajectory` now registers argument auto-completion so users discover its `stop`, `off`, and `toggle` options inline instead of having to read the docs.

### Fixed

- `trajectory`: `/unipi:trajectory` registered its command with only a `description` and `handler`, so the TUI never offered argument completions and users had no way to learn that `stop`/`off`/`toggle` (or running it bare to open the server) existed. Added `getArgumentCompletions` to the registered command, returning `stop`, `off`, `toggle`, and a `(no argument)` hint that opens/reuses the server — matching the action set the handler already accepts.

### Changed

- All `@pi-unipi/*` packages and the umbrella re-versioned to `2.10.1` so npm installs keep a single synchronized workspace set and avoid nested stale package copies.

## [2.10.0] — 2026-08-25

This release adds UniPi Trajectory, a localhost-only live inspector for the current Pi session, with durable redacted sidecar telemetry for exact request/tool timings and provider metadata.

### Added

- `@pi-unipi/trajectory`: new `/unipi:trajectory` command that opens or reuses a local session inspector on `127.0.0.1:8176-8186`.
- Trajectory UI: turn-aware ledger, Input/Model/Tools overview timeline, search, turn/tool folding, drag-to-focus, detail tabs, light/dark theme toggle, and responsive inspector.
- Trajectory projection: current `SessionManager.getBranch()` is projected into user, assistant, tool, compaction, and branch records without mutating Pi session history or provider context.
- Trajectory telemetry: append-only `~/.unipi/trajectory/<session-id>.jsonl` sidecars capture redacted provider payload/options, tool schemas, response status/headers, TTFT, decoding/total request timing, token/cache usage, and tool execution duration when Pi hooks expose them.

### Changed

- Umbrella `@pi-unipi/unipi` now includes trajectory and the autocomplete registry lists `/unipi:trajectory`.
- All `@pi-unipi/*` packages re-versioned to `2.10.0` so npm installs keep a single synchronized workspace set and avoid nested stale package copies.

## [2.9.0] — 2026-08-24

This release upgrades the Pi SDK floor to `^0.84.0` (resolves to 0.84.2) across all packages and re-synchronizes every package onto a single shared version (2.9.0) after the 2.6/2.8 version drift caused npm to resolve registry copies of workspace packages — stale peers that broke clean installs (ERESOLVE) and shipped nested stale copies. It also ships the compactor auto-compaction abort fix (issue #30).

### Changed

- `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core` peer dependencies bumped `^0.80.0` → `^0.84.0` in the root and all 21 workspace packages. Users on Pi 0.84.x can now co-install Unipi packages cleanly; users on older Pi releases should stay on `@pi-unipi/*@<2.9.0`.
- All packages and the umbrella re-versioned to a single `2.9.0`; every `@pi-unipi/*` cross-dependency pin updated to match, so npm links workspace packages instead of pulling registry snapshots.

### Fixed

- `compactor`: percentage auto-compaction now triggers at `agent_end` instead of `turn_end`. Pi's `ctx.compact()` aborts the active agent operation first, and `turn_end` fires between turns of a still-running agent loop, so the trigger killed the next in-flight provider request with `stopReason=error "This operation was aborted"` and the turn was lost (issue #30). `agent_end` fires only after the run has fully settled — the same checkpoint Pi core uses for its own native auto-compaction.

### SDK migration (0.80 → 0.84)

- `btw`: child sessions now pass `modelRuntime` (extracted from the extension-facing `ModelRegistry` facade) to `createAgentSession` — the SDK replaced the removed `modelRegistry` option in 0.81. The synthetic BTW resource loader implements the new `getSystemPromptSource`/`getAppendSystemPromptSources` members.
- `subagents`: agent-runner sessions migrated the same way; `sessionOpts` now typed as `CreateAgentSessionOptions` (the SDK made `createAgentSession`'s options parameter optional).
- `background-tasks`: fusion SDK integration test migrated off the removed `AuthStorage`/`ModelRegistry.create()` onto `ModelRuntime.create({ authPath })` with `registerProvider`/`getModel`.
- Compatibility verified against 0.84.2: extension event map is additive only (`agent_settled`, `before_provider_headers`, `session_info_changed` added; nothing removed), all consumed event payloads byte-identical, and `ctx.compact()` retains its abort-first semantics that issue #30's fix targets.

### Fixed (test suite / docs hygiene)

- `utility`: removed 11 stale test files targeting modules deleted by the 2026-08 ponytail audits (`diff/*`, `display/*`, `cache/ttl-cache`, `tools/batch`, `tui/settings-inspector`) — the workspace suite had been failing 27 tests since those deletions; badge-settings TUI test updated to the badge-only settings surface; dropped the unused `@types/diff` devDependency.
- `utility`: README rewritten to match shipped features (batch tool, Shiki diff rendering, TTL cache, and display-capability modules were previously deleted); root README tool table no longer lists the removed `ctx_batch` tool.
- `web-api`: two stale tests updated to the post-ponytail API (`getRankedProviders` instead of the removed `getProviderByRank`; the removed `checkWigoloHealth` replaced by asserting the actionable install hint on `WigoloUnavailableError`).
- Root-level `tests/info-screen-boot-timer.test.js`, `tests/prefix-provider-payload.test.js`, and `tests/prefix-tool-registration.test.js` remain broken from pre-existing toolchain drift (`.js`-specifier imports that Node 24 type-stripping cannot resolve); they are outside the workspace test step and documented here rather than silently ignored.

## [2.6.2] — 2026-08-22

This release fixes split-package installs: since 2.0.11, every per-package `pi` manifest shipped with empty `extensions`/`skills` arrays, so installing a split package like `@pi-unipi/ralph` on its own loaded nothing (issue #29). The regression came from `d914a25` ("fix: disable split package resource discovery", v2.0.11), which blanked the manifests of all nested packages to stop duplicate skill discovery inside the all-in-one umbrella install — without realizing pi reads a present manifest literally, so standalone installs also loaded nothing. Notify (#18) and compactor (#23) were fixed the same way earlier; this release fixes the remaining packages at once.

### Fixed

- All split packages now declare their real entry point and skills in their `pi` manifest: `ralph` (`./index.ts`, `./SKILL.md`), `workflow`, `memory`, `btw`, `ask-user`, `mcp`, `utility`, `milestone`, `kanboard`, `updater`, `image`, `info-screen`, `input-shortcuts`, `web-api`, `footer`, and `command-enchantment` (autocomplete) get `extensions`; `notify` additionally gets its `skills` mount; `subagents` additionally gets its `prompts` mount (issue #29).
- `background-tasks`, `subagents`, and `ralph` tarballs no longer ship test files (pre-existing since 2.6.0).
- Added a regression guard to `scripts/test-tarball-manifests.mjs`: any package with a `main` entry must declare non-empty `pi.extensions`, and every manifest mount must exist in the tarball.

### Notes

- `core` and `cocoindex` keep their intentionally empty manifests — they are libraries with no extension entry point, loaded transitively.

## [2.6.1] — 2026-08-20

This release fixes the notify settings overlay and recap model selector in terminals using the kitty keyboard protocol (Ghostty under Herdr), and makes the model selector reflect Pi's live model registry.

### Fixed

- `notify`: settings overlay and recap model selector match Up/Down/Escape/Enter/Tab/Space/Backspace via `matchesKey()` from `@earendil-works/pi-tui` instead of raw byte comparison — under the kitty keyboard protocol Escape arrives as `\x1b[27u` (Ctrl+C as `\x1b[99;5u`), so arrows/Escape silently did nothing and the selector could trap the user (issue #27).
- `notify`: Ctrl+C now always closes both overlays, even mid-filter.
- `notify`: recap model selector lists models injected from Pi's live `ctx.modelRegistry` instead of relying solely on `~/.unipi/config/models-cache.json`; when neither source has models it shows an actionable hint instead of a bare "No models found".
- `core`: model-cache paths are resolved per call (respects `HOME` changes; enables isolated tests).

### Added

- `/unipi:notify-event <event> <on|off>` — toggle a notify event without the TUI (escape hatch for terminals with overlay input problems); reports the resulting value and reminds that `/reload` re-registers listeners.

### Changed

- `notify`: arrows navigate inside selector filter mode without leaving it; `m` and `M` both open the model selector from the Recap tab.

## [2.6.0] — 2026-08-14

This release completes UniPi's provider prefix-cache preservation rollout, making model-visible state append-only within explicit cache epochs while adding privacy-safe diagnostics and bounded external results.

### Added

- **Provider-native prefix regression tests:** keyless tests capture real `pi-ai` OpenAI-compatible payloads before network I/O and verify ordinary turns plus Ralph, Memory, Milestone, Workflow, and Compactor snapshots extend the exact prior message prefix.
- **Privacy-safe cache diagnostics:** `/unipi:prefix-cache` reports session-local request/envelope HMAC fingerprints, structural prefix transitions, explicit epochs, and provider-reported cache-read/cache-write tokens without retaining raw prompts, arguments, schemas, or payloads.
- **Bounded result artifacts:** MCP and helper text has a hard 64 KiB model-visible ceiling. Raw results up to 16 MiB spill to private local artifacts with selective-read references and seven-day cleanup integration.
- **Prefix-cache architecture guide:** documents the append-only invariant, superseding snapshot semantics, cache-reset events, Pi/provider ownership boundaries, DeepSeek expectations, and compaction behavior.

### Changed

- **Deterministic tool lifecycle:** Ralph and CocoIndex tools register at extension construction time; custom subagent types and filesystem discovery use locale-independent deterministic ordering.
- **Compaction continuity is byte-stable:** resume snapshots no longer include wall-clock generation text, and UniPi's optional percentage compaction trigger remains disabled by default.
- **Ralph reminders are superseding snapshots:** unchanged reminders deduplicate within an epoch and reappear once after compaction.
- **Search output is bounded:** CocoIndex and session recall default to 10 results and hard-cap pages at 50; expanded recall hits are capped at 16 KiB.

### Fixed

- **Helper isolation recognizes current tool names:** child agents cannot recursively invoke `spawn_helper` or `get_helper_result` through stale exclusions.
- **Oversized external output no longer inflates every later cold request:** bounded previews retain useful head/tail context and fail safely if private artifact creation is unavailable.
- **Cache usage accounting counts distinct identical responses correctly** while deduplicating repeated active-context message objects.

## [2.5.0] — 2026-08-14

This release makes persistent memory migration reliable across standalone and all-in-one installs, while stabilizing workflow tool schemas and MCP registration.

### Added

- **Verified MemPalace catch-up:** migration state now records a source fingerprint and explicit discovered/imported/skipped/failed/verified counts. New or changed legacy memories trigger an idempotent catch-up, and partial runs retry instead of being marked complete.
- **MemPalace packaging contracts:** the umbrella tarball now ships the Python bridge and resolves it across standalone, bundled, nested npm, and explicit override layouts.
- **Deterministic MCP registration:** server discovery runs in parallel behind an atomic registration barrier with canonical tool ordering, duplicate-name rejection, rollback, and orderly disconnect.
- **Workflow lifecycle tests:** added coverage for call-time tool enforcement, nested workflow restoration, MCP schema stability, concurrent completion, and Milestone completion fallback.

### Changed

- **Workflow tools are enforced at execution time.** UniPi no longer mutates Pi's active tool list between workflow phases, preserving provider prefix-cache stability and avoiding stale tool schemas.
- **MCP schemas are canonicalized.** Equivalent JSON schemas now produce stable key/required ordering and Pi-compatible complete object schemas.
- **Milestone completion is per workflow run.** Overlapping runs are tracked independently and agent shutdown only reconciles runs that missed their normal completion event.
- **Memory markdown records preserve authoritative IDs** in frontmatter while retaining the legacy filename/title fallback for existing files.

### Fixed

- **All-in-one UniPi installs no longer silently fall back to SQLite** because `mempalace_bridge.py` was absent from the umbrella artifact or resolved relative to the wrong module.
- **MemPalace migration no longer false-completes** after bridge errors, timeouts, partial writes, or stale timestamp markers; exact persisted documents are re-read and verified before completion is recorded.
- **MCP no longer registers tools in network-completion order,** leak partial registrations after failure, or retain clients during shutdown.
- **Workflow completion and sandbox rules no longer bleed across nested or concurrent runs.**

## [2.4.2] — 2026-08-13

This release closes the unreachable-code and misleading-contract audit across runtime behavior, package artifacts, and integration events.

### Added

- **Release contracts:** added package-entry, production-graph, all-tarball manifest, standalone Subagents import, and isolated Utility dependency checks.
- **Workflow lifecycle events:** workflow commands now emit one start/end pair around their agent run; Milestone synchronizes on completion while retaining shutdown fallback.
- **Compactor event delivery:** successful compactions now emit the documented completion event, and Ralph emits iteration completion only after a real advance.

### Changed

- **Compactor configuration is now truthful.** Session continuity and sandbox off modes are enforced; language allowlists and output limits are active. Unsupported FTS5, display, and pipeline controls are hidden/deprecated rather than presented as working features.
- **Subagents honors type enablement.** JSON and custom-agent frontmatter disables are enforced before records or queue entries are created.
- **Notification priority is effective.** Explicit low/normal/high requests map to Gotify 2/5/8 and ntfy 2/3/5; omission preserves configured platform priorities.
- **Standalone Subagents ships built ESM.** The package now prebuilds verified `dist` JavaScript/declarations, publishes no tests or raw source, and exposes a standalone Pi extension entry.
- **Utility declares its real dependencies.** Direct Shiki usage is backed by `shiki`, and Pi TUI is declared as a host-shared peer.
- **Package roots and manifests were tightened.** Meaningful Footer/Updater barrels are canonical, redundant wrappers are gone, and root/workspace tarballs exclude tests while retaining every declared main.

### Fixed

- **Compactor resume context reaches the model once.** The hidden one-shot snapshot no longer gets consumed and discarded, and the system prompt remains prefix-cache stable.
- **Compactor sandbox policy is enforced.** Disabled tools are not registered, disallowed languages are rejected, and configured output limits reach shared executors.
- **`/unipi:status` responds immediately and truthfully.** Removed the dead request broadcast and guaranteed 500 ms wait; the command now points to live info and diagnostics surfaces.
- **Footer event wiring no longer waits on stale stats events.** Live Compactor segments continue reading session state directly.
- **Standalone package resolution works in strict installs.** Subagents imports by package name, and Utility resolves Shiki and Pi TUI from its installed package root.

### Removed

- Nine compiler-proven private declarations with no reads or callers.
- Fourteen source modules absent from the production graph, after preserving active `SectionData` and `RuntimeStats` type contracts.
- Permanently-zero Compactor indexed-byte accounting and unused package-root pass-through wrappers.

### Known issue

- The rank-2 LLM summarization provider still returns placeholder text. Its resolution is intentionally deferred pending the broader Wigolo/web-fetch architecture decision.

## [2.4.1] — 2026-08-13

### Fixed

- **`ralph`: loop status no longer invalidates the DeepSeek prefix cache.** The `before_agent_start` hook appended `[RALPH LOOP - name - Iteration N]` to the system prompt on every turn; because the iteration number changes each turn, this mutated the request prefix on every turn of a Ralph loop, forcing a full DeepSeek prefix-cache miss (~60K tokens re-billed at uncached price) per turn. The loop status now rides a hidden tail message (`unipi-ralph-loop-reminder`) so the cacheable prefix (system prompt + prior history) stays byte-stable across turns. The model still sees the loop name, iteration, and instructions.

## [2.4.0] — 2026-08-09

Image generation no longer requires an OpenRouter account, and `image_generate` can now edit an existing image.

### Added

- **`image`: image editing.** `image_generate` takes an optional `image` argument — a file path, `data:` URL, or raw base64 — and edits that image instead of generating from scratch. The result is saved and returned like any other generation.

  Editing regenerates the whole image rather than masking a region, so details you did not mention can still shift. Which model you pick matters a lot here: in testing, `flux.2-pro` preserved unmentioned elements faithfully, while the `gemini-*-image` family tended to reinterpret the whole scene. Note also that image models respond to what you *describe*, not to what you negate — "no text" is as likely to add text as remove it.

### Changed

- **`image`: generation works with any OpenAI-compatible provider configured in pi.** Previously pi-ai shipped exactly one image provider (`openrouter`), so generating an image meant holding an OpenRouter key even when you had several other providers signed in. Every provider in pi's model registry is now bridged into pi-ai's images collection at session start, backed by a single generic adapter that posts to `{baseUrl}/images/generations`.

  Credentials come from pi's existing auth — there is no separate image login. Gateways disagree on the response shape, so three known forms are normalized (`b64_json` + `media_type`, `b64_json` + `revised_prompt`, and a `data:` URL under `url`); a remote `url` is surfaced as text rather than silently dropped.

  Model *discovery* remains heuristic. pi's `ProviderModelConfig` has no `output` field and the provider composer rebuilds each model from a fixed field list, so an extension cannot record "this model emits images" — hence the name-based matching, with an explicit `provider/model-id` always accepted as the escape hatch.

- **`image`: errors name the provider you are actually using.** A missing key now points at that provider's environment variable and `/login` instead of unconditionally linking OpenRouter, and an unusable provider reports "no image-generation route" rather than the misleading "cannot generate images".

### Fixed

- **`image`: a valid API key could be reported as missing.** pi-ai resolves credentials to an `AuthResult` — `{ auth: { apiKey } }` — but the key was read from the top level, so generation failed with "No API key for provider" while a perfectly good credential sat one level down. Both shapes are now accepted.

- **`image`: models discovered from the registry lost their endpoint.** Provider registration rebuilt each model from a field list that omitted `baseUrl`, so setup appeared to succeed and only the first real request failed with "No baseUrl for image model". The endpoint is now carried through discovery, and filled in from the registry at resolve time for hand-typed `provider/model-id` references, which never carry one.

## [2.3.0] — 2026-08-07

Startup went from **23.1s to 0.75s** — 31× faster, and within ~0.7s of bare `pi` with no extensions at all. A cold start (empty cache) is now the same speed as a warm one.

### Changed

- **`info-screen`: `showOnBoot` is now `bootMode`, with three states.** `"on"` keeps the dashboard up until you dismiss it, `"auto-close"` (the new default) closes it after `bootTimeoutMs`, and `"off"` never builds it at all. All three are configurable from `/unipi:info-settings` — `←/→` cycles the mode, and the row below adjusts the delay in 0.5s steps (clamped 0.5–30s). Any keypress cancels the auto-close, so the dashboard stays put if you are reading it. `/unipi:info` opened by hand never auto-closes.

  Existing configs migrate automatically on read: `showOnBoot: true` → `"on"`, `false` → `"off"`. Note that `true` maps to `"on"` rather than the new `"auto-close"` default, so nobody's startup behaviour changes underneath them. An explicit `bootMode` always wins over the legacy key.

- **`info-screen`: dashboard panels load lazily.** Only the visible tab fetches at boot; the rest are prefetched 1.5s later, and any tab opened before that fetches on demand. Previously all ~17 panels were built before the first prompt was ready, including when the dashboard was disabled entirely.

- **`memory`: orphaned markdown is imported on first use rather than at startup.** `syncOrphanedFiles()` spawns a Python bridge; nothing reads its result until memory is actually used. A `.md` file dropped into a project directory is now picked up by the first memory tool call instead of at boot. Still runs exactly once per session; nothing is lost.

- **`unipi`: the all-in-one entry now ships as a prebuilt bundle.** pi loads extensions through jiti with its module cache disabled, so every startup transpiled ~577 TypeScript files from scratch — the factory calls themselves take 5ms, the cost was entirely transpilation. `pi.extensions` points at `packages/unipi/bundled.js`, built by `npm run build` and regenerated automatically by `prepublishOnly`. Only `@pi-unipi` sources are bundled; every third-party dependency stays external and resolves from `node_modules` at runtime.

### Performance

- **`info-screen`: usage stats are cached per file (8,671ms → 70ms).** `parseUsageStats()` re-read and re-parsed the entire session history on every call — 2.6GB across 600 JSONL files — and ran twice per startup. Results are now cached in `~/.unipi/cache/usage-stats.json`, keyed on each file's mtime and size. Statting 600 files costs ~1ms while only ~11 change on a busy day, so ~96% of the work was recomputing an immutable result.

  This single function was the dominant startup cost. Because it never yielded, every other extension's `session_start` handler queued behind it — which is why earlier profiling rounds blamed unrelated extensions for ~9s each. They were waiting on this, not doing work.

- **`info-screen`: the usage parser no longer blocks the event loop.** A new `parseUsageStatsAsync()` yields via `setImmediate` between files, so even a cold parse cannot freeze keystrokes or the first paint. The reader also streams line-by-line instead of `readFileSync` — the largest single session file here is 213MB and was being materialized in full, along with its `split("\n")` array.

- **`memory`: MemPalace bridge calls are async (1,581ms → ~0ms of blocked loop).** The status-bar counts called `listAll()` and the cross-project listing through `spawnSync`, freezing the process for the full Python round-trip just to render `mem 32p/2262all`. Added `runBridgeAsync` plus `listAllAsync()` / `listAllProjectsCachedAsync()`; the status bar paints immediately and fills in when the bridge answers. The cross-project listing is additionally cached for 60s, invalidated on any store or delete.

- **`info-screen`/`utility`: pi's version is resolved without spawning a subprocess (710ms → ~1ms).** `getPiVersion()` probed a hardcoded path for one specific Node version and, on any other, fell through to `execSync("pi --version")` — starting a whole second pi process, synchronously, twice per startup. A shared implementation in `@pi-unipi/core` now walks up from pi's own entry point, resolving the symlink first (the binary on `PATH` is typically a shim), and caches the result.

### Fixed

- `info-screen`: the overview panel displayed **`Pi Version: unknown`**. The `execSync` fallback matched `/v([\d.]+)/`, requiring a literal `v` prefix that pi no longer emits — so it paid 710ms per startup *and* still failed. Now shows the real version.
- `info-screen`: `bootTimeoutMs` had existed in `InfoScreenSettings` and in user configs since the beginning but was never connected to anything. It now drives the auto-close timer.
- `info-screen`: `writeSettingsFile()` called `require()` from an ESM module, which throws under Node's module-format detection whenever the settings directory does not already exist.
- `unipi`: `diff` is a dependency of `@pi-unipi/utility` and lives in that package's own `node_modules`. That resolves fine under jiti (each file resolves from its own location) and fine when installed (npm hoists it), but was unresolvable from a single bundle in a local checkout. Now declared at the root.

## [2.2.7] — 2026-08-04

### Fixed
- `ralph`/`subagents`/`memory`: these still pinned `@pi-unipi/info-screen@2.2.0`, so npm installed a second, **pre-fix** copy of the info-screen overlay nested under each of them — meaning the Escape-key fix released in 2.2.5 did not reach the info overlay for those install paths. Republished with the pin updated to `2.2.1`. No functional change to the packages themselves; this is purely a dependency-consistency fix.

## [2.2.6] — 2026-08-04

### Fixed
- `updater`: **the changelog never appeared after an update.** `CHANGELOG.md` was not in the published tarball at all, and both the update prompt and `/unipi:changelog` resolved it from `process.cwd()` — which only exists when pi happens to be running inside the UniPi checkout. The file now ships, and a new `resolveChangelogPath()` resolves it from the installed package location with a working-directory fallback.
- `updater`: `getNewerVersions()` stopped only on an *exact* version match, so when the installed version was absent from the changelog (a local build, or a version newer than any entry) it reported every historical release as new. It now compares versions properly via `isNewerVersion()`.
- `image`: `image_generate` failed with a bare `Unknown provider: omniroute`. pi-ai's images collection carries its own provider set (currently only `openrouter`) and is separate from pi's chat model registry, so a chat provider's image models were selectable but could never generate. The error now names the providers that can generate and points at `/unipi:image-settings`, models that cannot generate are marked `(cannot generate)` in the picker, and selecting one requires a confirming second Enter.

## [2.2.5] — 2026-08-04

### Fixed
- `image`/`notify`/`compactor`/`footer`/`info-screen`: **Escape did not close overlays or exit a filter/search field.** Every overlay detected Escape with `data === "\x1b"`, but under the kitty keyboard protocol Escape arrives as `\x1b[27u` (and as `\x1b[27;1;27~` with modifyOtherKeys), so the comparison silently failed and the overlay could not be cancelled. All 19 occurrences across 8 files now use pi-tui's `matchesKey(data, "escape")`, which understands every encoding. Arrow keys, Enter and Ctrl+C in the image model selector were converted to `matchesKey` for the same reason.
- `image`: the model selector's filter now supports arrow-key navigation without leaving the filter, and escape sequences can no longer be typed into the filter as literal text.

## [2.2.4] — 2026-08-04

### Fixed
- `image`: `image_recognize` failed with `Unexpected token 'd', "data: {"id"... is not valid JSON` against OpenAI-compatible gateways that reply with `text/event-stream` even when streaming was not requested (omniroute does this). Both the OpenAI and Anthropic paths called `response.json()` on an SSE body. Responses are now read as text and, when the body is a `data:`-framed stream, the deltas are parsed and concatenated — handling OpenAI `choices[].delta.content` and Anthropic `content_block_delta` shapes, skipping malformed frames rather than failing the request. Both requests now also send `stream: false`. A non-SSE body that still cannot be parsed reports its first 200 characters instead of a bare parser error.

## [2.2.3] — 2026-08-04

### Added
- `image`: the model pickers now accept a **custom model reference** — press `c` in `/unipi:image-settings` and type any `provider/model-id`. Image-generator detection is necessarily heuristic (third-party providers publish no image metadata), so this guarantees no model is ever unreachable. `resolveImageGenModel()` and `resolveVisionModel()` accept a well-formed reference even when it is absent from the catalog, while a bare typo with no provider segment still gets the "Unknown model" list, and a registered text-only model still gets the precise "does not accept image input" error. An empty catalog is no longer a dead end — the picker opens anyway so a model can be entered by hand.

## [2.2.2] — 2026-08-04

### Fixed
- `image`: the model pickers only offered pi-ai's built-in OpenRouter catalog, so image models from providers registered by other extensions (such as `pi-omniroute-bridge`) could not be selected. The obvious filter — `output.includes("image")` — matches nothing, because third-party providers surface text-to-image endpoints as ordinary chat models with no declared output modality. `listAllImageGenModels()` now merges the built-in catalog with registry-contributed generators, de-duplicated by `provider/id`; `image_generate` resolves against the same merged list. Against a real 393-model omniroute registry this goes from 34 to 46 selectable generation models with no false positives.
- `image`: **critical** — opening a model picker left both the overlay and the settings menu holding keyboard focus, so arrow keys drove the hidden menu and neither could be closed or toggled. `pickModel()` called `ctx.ui.custom()` without awaiting the promise it returns, letting the settings loop mount the next `ctx.ui.select` while the overlay was still on screen. It is now awaited, and the chosen model is persisted only after the overlay closes so cancelling leaves the config untouched.
- `image`: the model-selector overlay swallowed `Ctrl+C`, leaving no way out, and deferred its close by 500ms after selection — which let the caller resume while the overlay still had focus. `Ctrl+C` now always closes, including mid-filter, and selection closes synchronously.

## [2.2.1] — 2026-08-04

### Fixed
- `notify`: `permission-prompt-message.ts` was missing from the published tarball, so `@pi-unipi/notify@2.2.0` failed at load with `Cannot find module './permission-prompt-message.js'` — which took the whole umbrella extension down on a clean install. The package's `files` array was an explicit per-file whitelist and the new module was never added to it; it is now a `*.ts` glob so root-level modules cannot be omitted again. Caught by booting the published tarball in a clean directory rather than testing the workspace copy.

## [2.2.0] — 2026-08-04

### Breaking Changes
- **BREAKING:** `web-api` provider `source:` numbers changed, because wigolo was inserted at rank 1 for both search and read. Search is now `1`=wigolo `2`=DuckDuckGo `3`=Jina Search `4`=SerpAPI `5`=Tavily `6`=Perplexity (was `1`=DuckDuckGo `2`=Jina `3`=SerpAPI `4`=Tavily `5`=Perplexity). Read is now `1`=wigolo `2`=Jina Reader `3`=Firecrawl `4`=Perplexity (was `1`=Jina Reader `2`=Firecrawl `3`=Perplexity); read `0` is still the built-in smart-fetch engine. Migration: if you pass an explicit `source:` to `web_search` or `multi_web_content_read`, add 1 to the old number — or simply omit `source:` and let auto-selection pick, which now also falls through on provider failure. Omitting `source:` requires no change.
- **BREAKING:** `web_llm_summarize`'s `source:` range is corrected to `1`=Perplexity `2`=LLM Summarize (`maximum` was previously documented as `3` and listed read providers, which never matched the registered summarize providers). Migration: use `1` or `2`, or omit `source:`.

### Added
- `image`: new `@pi-unipi/image` package with two agent tools. `image_generate` creates images from a text prompt using pi-ai's image catalog (34 models — FLUX.2, Gemini 3 Pro Image, GPT-5 Image, Recraft, Riverflow — served through OpenRouter), returning them inline and saving them to disk (default `~/.unipi/images`). `image_recognize` analyzes an image with any model whose input modality includes `image`, accepting a local file path, `data:` URL, or base64, with a customizable system prompt. Both are configured via `/unipi:image-settings`, which includes a filterable model picker.
- `web-api`: [wigolo](https://github.com/KnockOutEZ/wigolo) is now the default search and read provider (rank 1 for both, enabled by default) — a local-first engine with multi-engine search, rank fusion and on-device reranking, at $0/query with no API key. It is an **optional** dependency loaded through a dynamic `import()`, because wigolo-sdk is AGPL-3.0-only while UniPi is MIT; UniPi therefore ships no AGPL code. Install with `npm install -g wigolo && npx wigolo init`. Existing providers renumbered: search `2`=DuckDuckGo `3`=Jina `4`=SerpAPI `5`=Tavily `6`=Perplexity; read `2`=Jina Reader `3`=Firecrawl `4`=Perplexity.
- `web-api`: auto-selection now falls through to the next-ranked provider when one fails, so an enabled-but-uninitialized wigolo cannot break every web call. An explicit `source:` stays strict so the user's choice is respected and reported.
- `notify`: new built-in `permission_request` event bound to `@gotgenes/pi-permission-system`'s `permissions:ui_prompt` broadcast, which fires only when a human-facing permission prompt is about to be shown (no spam from policy auto-allow/deny or session approvals). Forwarded subagent prompts are marked `(forwarded)`. Disabled by default (closes #25).
- `core`: new `tui-width` helpers (`normalizeWidth`, `boxInnerWidth`, `adaptiveInnerWidth`, `shouldRenderBorder`, `contentWidth`, `safeRepeat`, `WidthKeyedCache`) encoding the invariant that a rendered line must never exceed the terminal width.

### Fixed
- `ask-user`/`tui`: Pi no longer crashes on terminals narrower than 42 columns. Every box-drawing component floored its content width at `Math.max(40, width - 2)`, emitting lines of at least 42 columns regardless of the real terminal width; pi-tui's differential renderer throws on any over-wide line, stopping the TUI and taking the agent down. `ask-ui` and `launcher-ui` were fully exposed since they mount in the editor container at the raw terminal width. Components now clamp to the available width and drop the border below 12 columns. Applied to the same pattern in 15 other overlays across updater, info-screen, compactor, footer, mcp, notify and utility.
- `ask-user`/`mcp`: render caches are now keyed on width. `requestRender()` does not invalidate on resize, so shrinking the terminal previously returned stale, over-wide lines and the next frame threw.
- `ask-user`: `launcher-ui` measured its header with `String.length` on a string containing an astral emoji; now uses `visibleWidth`.
- `subagents`: Pi no longer crashes on exit with "This extension ctx is stale after session replacement or reload" when a background agent (typically the session-name generator) is still running. Pi disposes the session immediately after `session_shutdown` resolves, which invalidates the extension runtime; `abortAll()` only signals the AbortController, so the in-flight promise settled a microtask later and called `pi.sendMessage()` on a dead runtime, throwing from an async continuation with nothing to catch it. Late completions are now dropped via a `sessionEnded` guard set before `abortAll()`. The guard is scoped to the extension factory, so `/new`, `/fork` and `/resume` (which also emit `session_shutdown`) reset it when pi re-invokes the factory.
- `web-api`: the DuckDuckGo provider returned zero results against live markup. Snippet bodies contain `<b>` query highlights so the `[^<]*` pattern never matched; results were paired by index across two independent match streams, so one snippet-less result shifted every later snippet onto the wrong title; and URLs were returned as `//duckduckgo.com/l/?uddg=…` redirect wrappers rather than real destinations, with HTML entities left undecoded.

## [2.1.3] — 2026-07-22

### Added
- `notify`: support Pi's `agent_settled` lifecycle event as a separate configurable notification from `agent_end`, so users can route retry/error runs and final settled completion to different platforms or sounds (fixes #24).

### Fixed
- `tests`: run TypeScript test suites through `tsx` instead of Node's built-in TypeScript stripping so the workspace test suite passes on Node builds without `--experimental-strip-types` support.
- `tests/package-manifest`: allow split packages such as `@pi-unipi/compactor` to declare package-internal `pi.skills` while still blocking hoisted `node_modules` resource paths.

## [2.1.2] — 2026-07-06

### Fixed
- `compactor`: registered the package extension and skills in `packages/compactor/package.json` (`pi.extensions` pointing at `./index.ts`, `pi.skills` at `./skills`) so the standalone `@pi-unipi/compactor` package loads its extension and skills without relying on umbrella auto-discovery (fixes #23). Mirrors the notify fix from #18.

## [2.1.1] — 2026-07-02

### Added
- `core`: new `withHerdrBlocked(pi, label, fn)` helper that emits `herdr:blocked` active/inactive around an awaited blocking UI so the herdr integration surfaces `blocked` agent status.
- `ask-user`/`subagents`: agent-driven blocking overlays now report `blocked` to herdr — `ask_user` (label `ask_user`), session launcher (label `ask_user: launch`), and the `get_helper_result` live conversation viewer (label `helper viewer`).
- `info-screen`: new "Show on boot" toggle at the top of `/unipi:info-settings` (persisted via `saveInfoSettings`).

### Fixed
- `info-screen`: the info overlay no longer blocks startup. `fetchAllBackground()` now defers each group's `dataProvider()` to a background macrotask with a `_destroyed` guard instead of running them synchronously before the first `await`. Startup cost dropped from ~4750ms to ~1ms; data loads reactively after the TUI is up.
- `memory`: skip the Python `ping` `spawnSync` when recently verified via `~/.unipi/memory/.mempalace-ping-verified` (24h TTL). New `memPalaceCall<T>()` wrapper invalidates the flag on a null result so a broken palace gets re-verified next session. Warm-start saving ~484ms.

## [2.1.0] — 2026-06-27

### Breaking Changes
- **BREAKING:** `@pi-unipi/*` peer dependencies on `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, and `pi-agent-core` are now `^0.80.0` (was `^0.78.0`). Users must run Pi `0.80.0` or newer. Pi `0.80` moved pi-ai's global API to `@earendil-works/pi-ai/compat` (unipi only imports core types from the root, so extensions keep working at runtime), removed the `/base` selective-provider entry points, and renamed `ExecutionEnvExecOptions` to `ShellExecOptions`. Migration: update Pi (`pi update`) to 0.80+ before updating unipi.
- **BREAKING:** `@pi-unipi/memory` now uses [MemPalace](https://github.com/mempalace/mempalace) as its primary backend. On first load it auto-installs MemPalace via `uv` and migrates all existing memories into a MemPalace palace at `~/.mempalace/palace`. **Prerequisite:** install [`uv`](https://docs.astral.sh/uv/) (`curl -LsSf https://astral.sh/uv/install.sh | sh`) before upgrading if you want the new backend — without `uv`, memory silently falls back to the existing SQLite store (nothing breaks, but migration will not run until `uv` is available). Legacy `~/.unipi/memory/` files are never modified or deleted; rollback by removing `~/.mempalace/palace` and `~/.unipi/memory/.mempalace-*` flags. First-run also downloads MemPalace's default ONNX embedding model (~80 MB, cached at `~/.cache/chroma/onnx_models/`).

### Changed
- `memory`: MemPalace is now the primary storage backend. On first load the package auto-installs MemPalace via `uv`, performs a one-way read-only migration of all legacy SQLite + markdown memories into MemPalace drawers, and serves all reads/writes/searches from MemPalace. Falls back to the bundled SQLite + sqlite-vec store when MemPalace or `uv` is unavailable. Markdown files remain the durable human-readable tier.
- Bumped `@earendil-works/*` peer dependencies from `^0.78.0` to `^0.80.0` (resolves to 0.80.2).

### Added
- `@pi-unipi/memory` now ships `bridge/mempalace_bridge.py` — a single-command JSON bridge to MemPalace's Python API (palace drawers) with deterministic drawer IDs, auto-install, and one-way auto-migration.

### Fixed
- `memory`/`ask-user`/`info-screen`/`mcp`/`milestone`/`notify`/`ralph`/`updater`/`utility`/`web-api`/`workflow`: replaced `new URL('.', import.meta.url).pathname` with `dirname(fileURLToPath(import.meta.url))` so package-internal paths resolve correctly on Windows (the old pattern produced malformed `E:\C:\Users\...` paths).
- `notify`: registered the package extension in `packages/notify/package.json` so notify loads without relying on umbrella auto-discovery (fixes #18).
- `tests/package-manifest.test.js`: allow split packages to register package-internal extensions (e.g. notify's `./index.ts`) instead of asserting all `pi` fields are empty.

## [2.0.13] — 2026-06-01

### Fixed
- Removed duplicate `resources_discover` skill registration from split extension modules. The umbrella package manifest is now the sole source of skill resources, preventing collisions between `@pi-unipi/unipi/packages/*/skills` and sibling `@pi-unipi/*/skills`.

## [2.0.12] — 2026-06-01

### Fixed
- `unipi`: pin internal `@pi-unipi/*` dependencies to the exact release version so fresh installs cannot resolve stale split packages with conventional skill discovery.

## [2.0.11] — 2026-06-01

### Fixed
- `packages`: added explicit empty Pi manifests to split dependency packages so Pi treats them as non-resource packages instead of falling back to conventional `skills/` discovery.

## [2.0.10] — 2026-06-01

### Fixed
- `updater`: resolve the installed `@pi-unipi/unipi` package from sibling `node_modules/@pi-unipi/*` packages so nested installs report the real version instead of `0.0.0`.
- `packages`: removed Pi resource manifests from split dependency packages so installing the umbrella `@pi-unipi/unipi` package no longer double-loads skills from both `packages/*/skills` and sibling `@pi-unipi/*/skills` packages.

### Changed
- `deps`: updated Pi peer and development dependencies to the current `@earendil-works/*` `0.78.0` package family.

## [2.0.9] — 2026-05-28

### Fixed
- `kanboard`: updated the npm package `files` manifest so runtime sources imported by `index.ts` (`commands.ts`, `parser/`, `server/`, `tui/`, and `types.ts`) are included in the published tarball.

## [2.0.8] — 2026-05-24

### Added
- `ci`: added a GitHub Actions workflow that installs dependencies, typechecks, and runs the workspace test suite on push and pull request.
- `repo`: added the MIT license file to the repository.

### Changed
- `unipi`: migrated Pi extension imports and peer dependencies from the legacy `@mariozechner/*` packages to the current `@earendil-works/*` Pi base.
- `tools`: migrated tool schemas from `@sinclair/typebox` to Pi's current `typebox` package.
- `deps`: updated the Pi peer dependency family to `0.75.5` and aligned lockfile resolution across workspaces.

### Fixed
- `info-screen` and `utility`: updated Pi package discovery paths to look under `@earendil-works/pi-coding-agent`.
- `web-api`: added missing `@types/mime-types` for clean typechecking with the updated dependency graph.

## [2.0.7] — 2026-05-24

### Fixed
- `unipi`: changed the umbrella package manifest to load its package-internal all-in-one extension instead of hoisted `node_modules/@pi-unipi/*` paths, fixing npm installs where no `/unipi:*` commands or skills loaded.
- `unipi`: ships package metadata and root `SKILL.md` files needed by package-internal extension and skill paths.
- `notify`: supports the lossless `rpiv:ask-user:prompt` payload shape while preserving UniPi's existing flat `ask_user_prompt` payload formatting.
- `notify`: avoids a type-only dependency on an unpublished `@juicesharp/rpiv-ask-user-question/events` subpath so `tsc --noEmit` passes with the current npm package.

### Changed
- `notify`: extracted ask-user prompt notification formatting into `ask-user-prompt-message.ts` with regression coverage for lossless and legacy payloads.
- `unipi`: added a package-manifest regression test that verifies npm pack output contains every path declared in the Pi manifest.

## [2.0.6] — 2026-05-19

### Fixed
- `updater`: compare versions numerically instead of using string inequality so stale cache entries never prompt downgrades like `2.0.5 → 2.0.4`.
- `updater`: bypass the check interval when the cached npm version is older than the installed version, forcing a fresh registry check after local/source releases.

## [2.0.5] — 2026-05-19

### Added
- `footer`: added terminal-aware `colorMode` support (`auto`, `truecolor`, `256`, `none`) with xterm-256 downgrading for terminals that do not support 24-bit color.
- `footer`: added Apple Terminal detection so footer hex colors render with 256-color ANSI escapes instead of being swallowed.

### Fixed
- `autocomplete`: stripped Pi source tags like `[u:npm:@pi-unipi/unipi]` from enchanted `/unipi:*` suggestions while keeping package tags such as `[workflow]`.
- `footer`: preserved distinct workflow/category colors on non-truecolor terminals and expanded color-mode tests for truecolor, 256-color, no-color, and Apple Terminal paths.
- `utility`: aligned terminal capability detection with footer color fallback behavior, including Apple Terminal truecolor suppression.

### Changed
- `unipi`: regenerated the bundled all-in-one extension for the release.

## [2.0.4] — 2026-05-18

### Added
- `notify`: added `suppressWhenFocused` support for native notifications so noisy completion/attention alerts can be skipped when Pi is already focused.
- `compactor`: added optional UniPi-managed percentage auto-compaction with configurable threshold, cooldown, repeat-growth safeguards, and notifications.

### Fixed
- `notify`: validated Linux focus detection and corrected Windows foreground PID typing for reliable focus suppression.
- `compactor`: fixed preset/profile application so the Pipeline tab reflects selected profiles (`precise`, `balanced`, `thorough`, `lean`) instead of staying all `off`.
- `compactor`: handled Pi's post-compaction `null` context usage state and repeated long-session auto-compactions without triggering compaction loops.

### Changed
- `compactor`: expanded README and skill docs with user commands, settings, agent tools/skills, benchmark notes, and chronological Pi hook flow.
- `unipi`: regenerated the bundled all-in-one extension for the release.

## [2.0.3] — 2026-05-16

### Fixed
- `ask-user`: expanded historical `ask_user` results now show the previous question, context, and available options when toggled with Ctrl+O.
- `workflow`: cached worktree argument completions per working directory so `/unipi:worktree-merge` suggestions do not rescan `.unipi/worktrees` on every autocomplete call.

### Changed
- `ask-user`: tool result details now preserve normalized options and input-mode metadata for richer TUI history rendering.
- `unipi`: regenerated the bundled all-in-one extension after the ask-user and workflow fixes.

## [2.0.2] — 2026-05-16

### Breaking Changes
- BREAKING: `btw` commands moved from `/btw`, `/btw:new`, `/btw:tangent`, `/btw:clear`, `/btw:inject`, and `/btw:summarize` to `/unipi:btw`, `/unipi:btw-new`, `/unipi:btw-tangent`, `/unipi:btw-clear`, `/unipi:btw-inject`, and `/unipi:btw-summarize`.

### Fixed
- `compactor`: `/unipi:session-recall` now searches the append-only session branch so messages omitted by compaction remain searchable.
- `compactor`: `/unipi:compact-recall` keeps working as a deprecated alias and points users to `/unipi:session-recall`.
- `autocomplete`: command registry now includes all working compactor commands, including `session-recall` and `compact-help`.
- `autocomplete`: registry now includes BTW commands and the CocoIndex package label.

### Changed
- `btw`: moved public commands from the bare `/btw*` namespace to `/unipi:btw*` for consistency with the Unipi command registry.
- `full-release`: replaced fragile manual command-registry checks with an automated autocomplete registry audit test.

## [2.0.1] — 2026-05-15

### Fixed
- `workflow`: require `@pi-unipi/core@^2.0.0` so npm installs do not load stale nested core 0.1.x copies that lack `getBlockedToolsForLevel`.
- `ralph`: align the internal `@pi-unipi/core` dependency range with the 2.x suite to avoid the same stale nested-core risk.
- `cocoindex`: extend update timeout handling with clearer timeout/error output and make `COCOINDEX_UPDATE_TIMEOUT_MS` configurable.
- `cocoindex`: skip huge generated/lock files in the default pipeline template to avoid runaway indexing and noisy generated artifacts.
- `ask-user`: render full questions, context, options, descriptions, actions, and prefill text in the tool-call display with wrapping for long prompts.

## [2.0.0] — 2026-05-06

### Breaking Changes
- BREAKING: `compactor` no longer provides project content indexing/search tools or commands (`content_index`, `ctx_index`, `content_search`, `ctx_search`, `content_fetch`, `ctx_fetch_and_index`). Use `/unipi:cocoindex-init`, `/unipi:cocoindex-update`, `/unipi:cocoindex-status`, `/unipi:cocoindex-search`, and `cocoindex_status` instead.
- BREAKING: `@pi-unipi/compactor` removed public content-command surface in favor of `@pi-unipi/cocoindex`; this is a breaking command and dependency migration.

### Added
- `@pi-unipi/cocoindex` package now includes optional `@lancedb/lancedb` dependency and first-class CLI bridge for workspace indexing/search.
- Added `/unipi:cocoindex-search` command and `/unipi:cocoindex-settings` status/management flow.
- Added `cocoindex_status` and `cocoindex_search` agent tools for index diagnostics/search.
- Added deprecation-aware UX and autocomplete registry checks in full-release checks.

### Changed
- `autocomplete` now explicitly includes CocoIndex + footer + ralph helper command suggestions and validates `/unipi:*` completeness.
- `worktree-merge/review` and ask-user documentation updates for workflow consistency.

### Fixed
- `autocomplete`: add missing suggestions for `/unipi:cocoindex-search`, `/unipi:footer-help`, and `/unipi:ralph-start`.
- `full-release`: add an enhanced autocomplete registry audit to catch registered commands missing from command suggestions.

## [0.1.18] — 2026-05-06

### Breaking Changes
- BREAKING: `compactor` no longer provides project content indexing/search tools or commands (`content_index`, `ctx_index`, `content_search`, `ctx_search`, `content_fetch`, `ctx_fetch_and_index`, `/unipi:compact-index`, `/unipi:compact-search`, `/unipi:compact-purge`). Use `/unipi:cocoindex-init`, `/unipi:cocoindex-update`, `/unipi:cocoindex-search`, `cocoindex_search`, and `cocoindex_status` instead.
- BREAKING: `sandbox_batch` no longer accepts embedded search items from the removed compactor content store; run `cocoindex_search` as a separate search tool call.

### Added
- `@pi-unipi/cocoindex` package — CocoIndex CLI bridge with LanceDB-backed project indexing and semantic search.
- `/unipi:cocoindex-init`, `/unipi:cocoindex-update`, `/unipi:cocoindex-status`, `/unipi:cocoindex-settings`, and `/unipi:cocoindex-search` commands.
- `cocoindex_search` and `cocoindex_status` tools for agent-accessible indexed content search and status diagnostics.
- Consent-based CocoIndex auto-install flow using `uv tool install 'cocoindex[lancedb]>=1.0'`, with `mise` fallback and shell-aware manual guidance.
- Default `.unipi/cocoindex/main.py` pipeline template using CocoIndex v1.0+ APIs, local filesystem ingestion, recursive splitting, OpenRouter embeddings, and LanceDB output.

### Changed
- `compactor`: project content indexing responsibilities moved to `@pi-unipi/cocoindex`; compactor now focuses on session compaction, recall, sandbox execution, diagnostics, and context budgeting.
- `footer`: replaced the old indexed-docs content-store segment with a CocoIndex status segment.
- `autocomplete`: removed old compactor content commands and added CocoIndex command suggestions.
- `workflow`: sandbox tool filtering now preserves safe extension tools (memory, web, ask-user, notifications) while removing only blocked tools for the active workflow level.
- `memory`: lifecycle reminders now respect the currently active tool set and track recall/store activity independently.
- `full-release` chore updated with CocoIndex package inventory, command registry checks, and explicit breaking-change changelog guidance.

### Fixed
- `cocoindex`: command registration now happens synchronously at extension load time instead of during `session_start`.
- `cocoindex`: pipeline template updated for CocoIndex v1.0+ APIs after `flow_def` removal.
- `cocoindex`: parsed v1.0+ files-processed output correctly during indexing.
- `cocoindex`: all-in-one `@pi-unipi/unipi` entry now imports and registers the CocoIndex extension.

## [0.1.17] — 2026-05-02

### Added
- `ask-user`: session launcher overlay for `new_session` action — spawns a new pi session with the selected model
- `footer`: zone-aware renderer with `zone`, `description`, `shortLabel` on every `FooterSegment`; extended `SemanticColor` with TPS tiers, zone colors, and workflow types
- `footer`: TPS (turns-per-second) tracker segment showing real-time agent throughput
- `footer`: clock and duration segments with live 1-second refresh timer
- `footer`: `hexColor` palette from spec — semantic colors mapped to exact hex values for consistent rendering
- `footer`: `/unipi:footer-help` command with full-label mode and help overlay showing all segments and their meanings
- `footer`: unified 3-category settings TUI (`Groups`, `Segments`, `Theme`) — simplifies the `/unipi:footer-settings` experience
- `autocomplete`: 4-tier sorting for cross-group command suggestions — unipi matches first, then unipi non-matches, system matches, system non-matches
- `autocomplete`: 37 tests for sorting logic, match quality, and cross-group behavior

### Fixed
- `compactor`: compaction stats always zero — fixed 5 interrelated bugs in stats tracking pipeline
- `updater`: resolve `@pi-unipi/unipi` version by package name instead of hardcoded relative path
- `unipi`: include all package `.ts` files in npm bundle (was missing source files)
- `notify`: add `ntfy-config.ts` to `package.json` files array so it ships on npm
- `autocomplete`: sort by match quality across unipi/system items — exact matches ranked above partial
- `footer`: apply hex color palette from spec for consistent segment colors
- `footer`: update workflow color mapping and add thinking level segment color
- `footer`: add TPS tracker icon entries and clock/duration segment definitions

### Changed
- Docs: all package READMEs rewritten with consistent 5-section format
- Docs: package titles deep-linked to their individual README files
- Footer preset updates and label mode support for compact display

## [0.1.16] — 2026-05-01

### Added
- `@pi-unipi/updater` package — auto-updater, changelog browser, and readme browser
- `/unipi:readme` command — browse package README.md files in TUI overlay
- `/unipi:changelog` command — browse CHANGELOG.md with version list and detail view
- `/unipi:updater-settings` command — configure check interval and auto-update mode
- Automatic npm registry check on session start (configurable interval: 30min/1h/6h/1d)
- Update notification overlay with changelog diff and one-key install
- Skip-version persistence — skip a version and re-prompt only when newer version appears
- Auto-update mode with countdown and cancel option
- Markdown terminal renderer for changelog and readme content
- `@pi-unipi/input-shortcuts` package — keyboard shortcuts with chord overlay, undo/redo, clipboard
- `/unipi:stash-settings` command — configure keyboard shortcuts and input behavior
- Project-level ntfy configuration — each project can use its own ntfy.json
- Theme-aware Markdown rendering in updater TUI overlays

### Fixed
- Updater TUI overlays (`readme-overlay.ts`, `changelog-overlay.ts`, `update-overlay.ts`) — replaced `data.toLowerCase()` with `matchesKey()` to fix arrow key sequences and uppercase keys like `G`
- Updater TUI overlays — replaced raw ANSI codes with `theme.fg()`, `theme.bold()`, `theme.bg()` for consistent styling
- `input-shortcuts`: suppress input listener while overlay is open to prevent background input
- `input-shortcuts`: suppress input listener during undo/redo operations
- `input-shortcuts`: remove undo throttle — allow consecutive undos without delay
- `input-shortcuts`: redo undo snapshot logic — 3 independent triggers for reliable state capture
- `input-shortcuts`: undo for typed text + cut/copy deferred action pattern
- `input-shortcuts`: overlay blocks editor API — refactor to deferred action pattern
- `input-shortcuts`: remove chord timeout — overlay stays open until ESC or action
- `input-shortcuts`: use `unipi:` prefix in `registerCommand()` calls
- `input-shortcuts`: register extension — add barrel file, unipi entry, command registry, info-screen
- `footer`: use icon style system in ralph and workflow segments
- `footer`: remove duplicate icon from WEB segment
- `footer`: add 1-second refresh timer so time segment updates
- `footer`: uppercase status short labels and fix duplicate memory entry

### Changed
- Updater TUI overlays use `truncateToWidth()` and `visibleWidth()` from `@mariozechner/pi-tui` instead of custom implementations
- Updater TUI overlays use proper box drawing frame (`╭╮╰╯│├┤`) matching other overlays

## [0.1.15] — 2026-04-30

### Added
- `@pi-unipi/footer` package — persistent status bar with live stats from all packages
- Footer settings overlay (`/unipi:footer-settings`) with group and segment toggles
- Thinking level colors and rainbow border for xhigh thinking
- Diff renderer with syntax highlighting via shiki
- Smart-fetch engine for web-api package (default read path)

### Fixed
- Notification dispatch made non-blocking (fire-and-forget)
- Diff renderer return types and shiki import corrections
- Footer extension path alignment with other packages
- Null returns in renderResult replaced with valid components
- Console.log/warn/error calls removed that caused TUI rendering issues

### Changed
- Footer segment icons and labels restructured
- Footer workflow/ralph/memory icons refined

## [0.1.14] — 2026-04-29

### Added
- Compactor UX overhaul — settings overlay, BM25 cache, auto-injection
- Context budget management with `context_budget` config option
- Dry run mode for compaction
- Two-tier skill system (project skills + bundled skills)
- Context savings analytics bridged to info-screen
- Compactor preset system (minimal/balanced/full/custom)
- Compactor search with proximity reranking
- Progressive throttling for large project indexing

### Fixed
- Compactor settings overlay type errors
- Context-mode AnalyticsEngine bridge to info-screen
- Stash artifacts resolved — merged compactor files restored

### Changed
- Compactor token stats info-screen integration improved
- Ralph loop guidance wiring into skill prompts

## [0.1.13] — 2026-04-28

### Added
- Info-screen module status response handling
- MCP catalog sync on session start
- Notify recap model selection (`/unipi:notify-recap-model`)
- ntfy push notification platform support
- Milestone tracking with `/unipi:milestone-onboard` and `/unipi:milestone-update`

### Fixed
- MCP server startup timeout handling
- Notify Gotify header bug
- Compactor init timing issues
- Footer command argument autocomplete

### Changed
- Compactor commands need `unipi:` prefix
- Footer icon style now configurable
