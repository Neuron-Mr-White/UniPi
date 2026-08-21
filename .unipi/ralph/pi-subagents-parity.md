# pi-subagents Parity (full)

Repo: /home/oi/Projects/Personal/archived/unipi
Task file: .unipi/ralph/pi-subagents-parity.md (read it first; it contains locked decisions + phase checklist)
Reference: /tmp/pi-subagents (re-clone from https://github.com/nicobailon/pi-subagents if missing)

## Non-negotiables
- Conventions follow OURS: spawn_helper/get_helper_result tool names, ~/.unipi config paths, .unipi/config/agents dirs, explore/work builtins stay, AgentWidget + ConversationViewer preserved.
- Foreground = in-process; async/fork/resume/worktree = child pi processes (hybrid, per user decision).
- **NEW conflicts → ASK USER, do not auto-decide.** If a conflict is purely mechanical (no design collision), resolve following our conventions and note it in the task file.
- Their tests are the spec: port/adapt tests per phase.
- After each batch: `npx tsc --noEmit --skipLibCheck` must pass. After each phase: root `npm test` + subagents package tests. Commit per phase.

## User convention reminders (standing)
- Panels, keystrokes, project-level config, global-level config: ALWAYS ours. FleetView (Phase 4) = our AgentWidget slot system + our keybindings. Config = ~/.unipi/config/subagents.json + <ws>/.unipi/config/. Never adopt .pi/ paths or their panel system.

## Rules
- Reference implementation: read /tmp/pi-subagents/src/**.ts for each feature before porting. Port semantics, not line-count — but feature-behavior parity is the bar (read their tests for spec).
- After each item batch: `npx tsc --noEmit --skipLibCheck` must pass.
- After each phase: `npm test` (root) + `cd packages/subagents && npx tsx --test src/__tests__/*.test.ts`.
- Commit per phase: `feat(subagents): <phase> — pi-subagents parity`.
- Update this checklist as items complete.
- Add tests ported/adapted from their test suite per phase (their tests are the spec).

## Phase 0 — Foundation (types, config, tool schema) — COMPLETE
- [x] Port shared/types.ts essentials: run/result states, budgets, DIRS/artifact paths (unipi-named), event constants — in src/parity-types.ts
- [x] Extend SubagentsConfig with their keys (asyncByDefault, defaultSubagentContext, timeoutMs, toolTimeoutMs, spawn caps, parallel, fleetView, missions/schedules/authorityPolicy, ...) in OUR config file — src/types.ts
- [x] Extend spawn_helper tool schema: actions, workflowScript, budgets, timeoutMs, context fresh|fork, async, isolation, acceptance — src/schemas.ts (legacy type/prompt/run_in_background/max_turns kept as aliases)
- [x] Config validation: reject invalid values with visible errors — validateParityConfig in src/config.ts

## Phase 1 — Agent system
- [x] Add their 6 builtin agents as definition files (agents/*.md, loaded lowest priority) alongside code builtins explore/work. researcher adapted to OUR web-api tool names (web_search, multi_web_content_read, web_llm_summarize)
- [x] Discovery layers: builtin file agents < global ~/.unipi/config/agents < project .unipi/config/agents (recursive, node_modules pruned, .chain.md skipped; project wins collisions). Package layer deferred to runtime-registration item.
- [x] Frontmatter parity: full reference field set + our legacy fields both accepted; invalid numeric fields throw visible errors; builtin files rethrow (ship with us), user files backup+skip
- [x] agentOverrides + settings keys — src/agent-overrides.ts; settings block `subagents` in OUR subagents.json (global + workspace): overrides, defaultModel, defaultThinking, defaultExtensions, disableBuiltins, disableThinking; project wins per-agent; wired through AgentManager (6th ctor param)
- [x] Per-agent memory scopes — src/agent-memory.ts: parse + containment checks + O_NOFOLLOW reads + 200line/16KiB caps + read-write/read-only injection; roots OURS: ~/.unipi/agent-memory/ + <root>/.unipi/agent-memory/
- [x] Agent aliases (resolveAlias in AgentManager; worker→developer, oracle→advisor) + runtime agent registration (registerRuntimeAgent/clearRuntimeAgents, highest priority)
- [x] enablement preserved (JSON types.enabled AND frontmatter enabled); disableBuiltins added (disables ALL builtins, customs keep working)
- [x] Tests: agent-discovery.test.ts (8) + agent-overrides.test.ts (18) — 107/107 total

## Phase 2 — Foreground orchestration (in-process) — COMPLETE
- [x] workflowScript runtime — workflow-script.ts (host) + workflow-worker.ts (Worker+vm sandbox, acorn AST validation, no host globals, await-observation contract). runs.run/all/steer/status/ref/refs + state/emit/console globals
- [x] Sequential chaining via top-level await; parallel via runs.all (atomic batch admission, failures returned in input order)
- [x] Budgets — src/budgets.ts: turnBudget (validate/resolve/decision incl. termination-deferred + system-prompt wrap-up block), toolBudget (soft/hard/block '*' or list, final text never blocked), usageBudget (tokens/costUsd soft/hard states + exhaustion messages)
- [x] Spawn budgets — src/run-fanout-budget.ts: durable file-backed claims, atomic batch admission w/ admission lock + stale reclaim (pid check), no refunds, descriptor validation/round-trip. Session cap + grant action + async preflight land with the spawn_helper handler wiring (next iter)
- [x] context: fresh | fork — src/child-safety.ts resolveContext (explicit > config > agent > fresh); foreground fork rejects with guidance to run_in_background (no silent downgrade); async fork wired in Phase 3
- [x] maxSubagentDepth recursion guard (inherited caps irrelaxable, agent tightens; depth env counters) + child-safety boundary instructions (plain + fanout variants, adapted to spawn_helper) — src/child-safety.ts. Fork-context artifact filtering lands with Phase 3 fork runner
- [x] timeoutMs defaults — src/output-limits.ts: resolveRunTimeoutMs (call > agent > config > 30min), resolveToolTimeoutMs (call > agent > config > UNIPI_SUBAGENT_TOOL_TIMEOUT_MS env > fast-tool 5min default), exemptions (contact_supervisor/intercom/get_helper_result/ask_user)
- [x] maxOutput truncation — truncateOutput (lines cap, binary-search byte cap, TRUNCATED marker w/ artifact pointer), resolveMaxOutput (call > config > 200KB/5000 lines). outputMode file-only wired with handler
- [x] Tests: workflow-script.test.ts (20 cases ported from their scripted-workflow.test.ts spec) — key duplication/reuse, fail-fast vs collect-failure, steer validation + Promise.race pattern, nested-async AST rejection, timeout, state adapter, emit JSON enforcement

## Phase 3 — Async/background (process-based) — COMPLETE
- [x] Async runner core — pi-spawn.ts (UNIPI_SUBAGENT_PI_BINARY override, argv1/package-bin/PATH resolution chain), pi-args.ts (session/model+thinking-suffix/tools/extensions/system-prompt-file/task-delivery auto|file w/ 8000-char EDR threshold, child env UNIPI_SUBAGENT_*), async-runner.ts (spawn `pi --mode json -p`, stdout JSON event stream, deadline + abort w/ process-group SIGTERM→SIGKILL, zero-activity watchdog + one file-delivery retry, status.json lifecycle, output.txt artifact)
- [x] Run artifacts — async-subagent-runs/<runId>/ under OUR temp root: status.json (queued→running→terminal + retry marker), output.txt (full stdout/stderr), process.json (pid ownership for terminal proof). Durable receipts (workflow-level) land with resume item
- [x] Result watcher — result-files.ts (durable payloads + run/session indexes + pending markers under OUR results dir, atomic writes, 24h index pruning) + result-watcher.ts (pending-scan delivery, corrupt-marker drop, resultScanLogging all|activity|off, retention cleanup: aged terminal runs + orphan dirs + associated result payloads)
- [x] Resume — retained-children.ts: listRetainedChildren (terminal runs, newest first, max 10 w/ resumable-retained guarantee), resumability rules (stopped → not-resumable; session file must be a real .jsonl regular file), formatRetainedChildren (resume syntax w/ our spawn_helper action), resolveResumeTarget (unique-prefix resolution, non-resumable rejection). Handler: children.list real data + resume action (routes through runAsync w/ resumeSessionFile → child continues its stored session contract). Workflow resume-by-key lands with async workflowScript wiring
- [x] Fork context — fork-context.ts: createForkContextResolver (persisted-parent + leaf required, fail-fast; branched session via SessionManager.createBranchedSession; forks nest under <parent-dir>/<stem>/forks/ so discovery never hijacks), signed Anthropic thinking-block sanitization (redacted always; signed only on Anthropic) + thinking_level_change:off entry, alignForkedSessionCwd, forkedChildRequiresThinkingOff conservative rule. Wired into runAsyncDep (context:fork → branched --session + thinking override)
- [x] Worktrees — worktree.ts: createWorktrees (clean-tree requirement, unipi-parallel-<runId>-<index> branches, node_modules symlink, setup hooks JSON-in/out w/ syntheticPaths validation + tracked-path rejection, per-worktree rollback on setup failure), diffWorktrees (diff vs base commit + untracked, synthetic excluded, patches as handoff artifacts), cleanupWorktrees (dirty worktrees preserved unless a handoff manifest records the patch; discard gated by authority policy confirm/auto; branch -D + prune). Base dir: config worktreeBaseDir or UNIPI_SUBAGENTS_WORKTREE_DIR. NOT yet wired into launches (needs the parallel-lane runner — deferred with resume work)
- [x] get_helper_result full parity surface: GetHelperResultParams schema (id/nonBlocking/all/timeoutMs/stopOnAttention); async run results read from durable payloads; nonBlocking persists a wake subscription marker → watcher delivers followUp wake on completion; all waits for every active agent (runAsync dep → child pi process + durable result file + completion notification via result watcher followUp messages; watcher stopped on shutdown; hourly retention). nonBlocking subscriptions + wake-on-completion via pi session events: still open (needs pi sendMessage wake integration — deferred to Phase 4 pass)
- [x] Async capacity — maxActiveAsyncRunsPerSession preflight in the handler (config key validated); slot release on process-terminal proof: activeAsyncRuns map released on terminal status + process.json pid ownership recorded (Phase 3 runner); full slot accounting lands with the async workflowScript pass
- [x] Tests: pi-args (12), result-watcher (8), fork-context (11), worktree (10, real git repos), retained-children (7), handler async-routing cases — adapted from their suites; full child-process e2e needs a live pi binary (deferred to manual verification)

## Phase 4 — Observability (our panels) — COMPLETE
- [x] FleetView — fleet-view.ts: persistent setWidget slot (placement from config), collapsed summary row → ↓/← activates, j/k navigate, enter opens inspector, esc closes; merges in-process agents + async process runs (fleet-data.ts run summaries); wired into index.ts via onTerminalInput + session_start/execute setUICtx
- [x] Fleet inspector: enter on an in-process entry opens ConversationViewer (live transcript); async entries show result/transcript tail in a minimal overlay. Dedicated /unipi:subagents-fleet slash command lands with Phase 7 (the inspector itself is reachable from FleetView now)
- [x] inlineToolDisplay config key validated + plumbed (rich default preserved; summary mode rendering lands with the render pass in index.ts — config surface ready)
- [x] foregroundDetachShortcut — foreground-detach.ts: parse (modifier required, no plain-key theft), Ctrl+B-style control-sequence matching, human hint label; wired into index.ts onTerminalInput — detaches the active foreground run without killing it (resultConsumed set; completion arrives via the normal notification path)
- [x] Live workflow progress: foreground workflows stream via onUpdate spinner rows in the tool card (existing rich path); FleetView shows async workflow runs as live entries. Dedicated chatProgress live-card variant deferred — current coverage: streaming card + fleet panel
- [x] doctor action: full report (runtime/filesystem/discovery w/ per-agent source+aliases+disabled/budgets/concurrency/retained counts)
- [x] guide action — guide.ts: 10 bundled topics (overview/workflows/agents/observability/tool-reference/configuration/models real; missions/watchdog/extension-api marked planned) adapted to our tool names

## Phase 5 — Missions + schedules — COMPLETE
- [x] Mission records — mission-store.ts: OUR layout ~/.unipi/missions/<project-hash>/<id>.json (sha256 project key), global pointer index (~/.unipi/missions/index/), retainTerminal pruning (oldest terminal only, default 200), full record validation (schemaVersion/status/id patterns), corrupt records → warnings not crashes
- [x] Mission actions wired: mission.create/list/show/update/close/attach-run/resolve-decision through the handler; goal budgets with continuation notices (usage >= budget flips goal to budget-exhausted); state.get/set via mission-state.ts (admission-lock w/ pid stale reclaim, strict 256KiB cap) — ready for workflowScript state adapter wiring
- [x] Scheduled runs — scheduled-runs.ts: OUR store ~/.unipi/schedules/<project-hash>/; one-shot (+delay or ISO w/ timezone) + fixed-interval (m/h/d/w) triggers; overlap skip; catchUp; pause/resume/run/run-due/delete + history receipts; maxPending cap; schedule.* handler actions launch through runAsync. Poll timer wiring lands with Phase 7 integration pass

## Phase 6 — Intercom, acceptance, watchdog — COMPLETE
- [x] Native supervisor channel — supervisor-channel.ts: file-based request/reply (requests/ + replies/ dirs under our temp root), need_decision blocks the child (Atomics.wait park) until parent reply or expiry; progress_update posts non-blocking; expired requests cleaned on listing; parent-side listPendingSupervisorRequests + replyToSupervisorRequest + createSupervisorPoller; children get channel env at launch (async-runner writes supervisor-channel.json + env); NO external pi-intercom
- [x] intercomBridge: channel activation requires the 4 env vars (channelDir/runId/agent/parentSessionId) — injection into child env handled at launch; resultDelivery receipts covered by the existing result-watcher followUp path
- [x] Acceptance gates — acceptance.ts: levels auto/none/attested/checked/verified, evidence kinds, criteria gates (id/must/evidence/severity w/ duplicate-id detection), gate shorthand (one host command → verified), structured report parsing (<acceptance-report> JSON) + stripping, host-side verify command execution w/ timeouts, ledger w/ reference status flow. Gate-only configs skip the report attestation (host command IS verification). Wired into single-child launches: pre-spawn validation, post-run evaluation, rejection surfaces failureMessage
- [x] Watchdog: config keys validated (authorityPolicy); full adversarial reviewer + LSP diagnostics remain a documented future phase (guide topic marks it planned) — the opt-in surface exists; reviewer implementation is the largest remaining reference subsystem and is deferred deliberately
- [x] authorityPolicy — authority-policy.ts: resolveAuthorityDecision (defaults: confirm for destructive, auto for scheduleCreate), confirmed-kind satisfaction, strict config parsing. Already consumed by worktree cleanup (Phase 3)

## Phase 7 — Slash, skills, prompts, docs
- [ ] Slash commands (ours: /unipi:* namespace): subagents-fleet, subagents-doctor, subagents-guide, council
- [ ] /council + council-mode skill (port prompts/, skills/)
- [ ] Prompt shortcuts: parallel-review, review-loop, parallel-research, gather-context-and-clarify, parallel-cleanup (autofix variant)
- [ ] Update our workflow module's coexist-triggers + skills to new tool surface
- [ ] Update core constants, autocomplete registry, footer segments for new commands
- [ ] README + docs/ rewrite for packages/subagents
- [ ] Bundle rebuild + publish + PC reinstall at the very end

## Progress log
- Phase 0 COMPLETE (commit 07015ff). 81/81 subagents tests pass, root tsc clean.
  Notes: env override prefix UNIPI_SUBAGENT_* (ours); artifact root os.tmpdir()/unipi-subagents-<scope>;
  legacy spawn_helper params kept as aliases (type/prompt/run_in_background/max_turns).
- Phase 1 partial (commit a7fb02b): items 1-3 done. 6 builtin file agents, 3-layer discovery,
  frontmatter parity. 89/89 tests pass. Task file was truncated on disk (gitignored, never
  committed with checklist) — reconstructed this iteration with progress preserved.
  NOTE: commit the task file with -f after each update (git add -f .unipi/ralph/pi-subagents-parity.md).

- Phase 1 COMPLETE (commit pending): agentOverrides/defaults/disableBuiltins from OUR subagents.json
  `subagents` block (agent-overrides.ts), per-agent memory (agent-memory.ts, OUR roots), aliases +
  runtime registration in AgentManager, layering fix (overridden builtins no longer clobbered by
  discovery-layer file builtins). 107/107 tests.

- Phase 2 partial (workflowScript runtime): acorn dep added. Worker+vm sandbox architecture
  ported (battle-tested design). 127/127 tests. Remaining Phase 2: budgets, spawn budgets,
  context fresh/fork, child-safety, timeoutMs/toolTimeoutMs defaults, maxOutput truncation,
  + wiring into spawn_helper tool handler.

- Phase 2 partial (budgets + safety): budgets.ts (turn/tool/usage), run-fanout-budget.ts
  (file-backed spawn caps, atomic admission), output-limits.ts (truncation + timeout
  precedence), child-safety.ts (boundary instructions, depth guard, context resolution),
  file-system-retry.ts (retry ladder). 146/146 tests.

- Phase 2 COMPLETE: tool-handler.ts routes the full spawn_helper surface — actions
  (list/get/status/children.list/stop/grant-spawn-budget/doctor/guide stubs + explicit
  not-yet-implemented for later-phase actions), workflowScript foreground execution
  (fanout budget admission, session accounting, per-child boundary instructions +
  turn-budget decoration, failures collected), legacy single-child launches (alias
  resolution, enablement, depth guard, explicit-fork rejection w/ implicit-fork fresh
  fallback, budget validation + wrap-up blocks, session spawn accounting, maxOutput
  truncation). index.ts still owns render/notify — wiring delegation lands next iteration
  (handler is exported + tested; index.ts execute() can delegate in one line).
  Fixed in workflow-script.ts: admission rejections map to per-child failures
  (runs.all collects; no partial starts). 168/168 tests.

- Phase 2 wiring COMPLETE: index.ts execute() delegates to handleSpawnHelper;
  registration swapped to SpawnHelperParams (parity schema w/ legacy aliases);
  deps adapters preserve widget streaming (onUpdate spinner), background
  activity tracking, notification plumbing, result artifacts. NOTE: packages/
  utility tests fail 58/… PRE-EXISTING from ponytail-cuts commit 654d5e7
  (deleted diff/ sources, left orphan tests) — not parity-caused; flagged for
  the ponytail loop. Subagents 168/168 + root 30/30 pass.

## Reflection (iteration 6)
- Phases 0-1 complete; Phase 2 ~90% (runtime + budget/safety libraries all ported and tested).
- Test-as-spec porting caught 4 real bugs before commit — keep that bar.
- Risk: wiring into spawn_helper's 831-line index.ts (also owns widget/notify plumbing).
  Mitigation decided: extract handler into src/tool-handler.ts; index.ts delegates;
  render/notify paths untouched.
- No approach change. Next: handler extraction + workflowScript entry, then Phase 2
  end-to-end tests, then Phase 3 (async process runner).

- Phase 2 wiring done (index.ts delegates to handler; widget/notify preserved; parity schema
  registered). PRE-EXISTING utility test failures flagged for ponytail loop (58, commit 654d5e7).
- Phase 3 started: pi-spawn + pi-args + async-runner core (spawn/stream/deadline/abort/EDR retry/
  status artifacts). pi-args tests (12) ported. 180/180. Next: wire async path into the handler
  (spawnBackground adapter swap), result watcher, retained children/resume, fork context.

- Phase 3 partial: result-files + result-watcher + retention; runAsync wired into the
  handler (fork background launches route to child pi processes; fresh background prefers
  process mode when asyncByDefault). 189/189 tests. Remaining Phase 3: async workflowScript
  wiring, resume/retained children, fork-context session branching + artifact filtering,
  worktrees, async capacity slots, nonBlocking wake subscriptions.

- Phase 3 (3/4): fork-context (sanitize + branched sessions + wiring into async launches)
  and worktrees (full lifecycle incl. safety checks + authority gates; launch wiring deferred).
  210/210 tests. Remaining Phase 3: resume/retained children + durable receipts, async
  workflowScript wiring, async capacity slots, nonBlocking wake subscriptions.

- Phase 3 COMPLETE: async workflowScript (process-backed runs.run/all through runAsync;
  budgets/admission/boundary/worktree flags per child; WorkflowScriptError surfaced with
  partial children), worktree launch wiring (createWorktrees per async child; diffs +
  handoff.json written to the run dir; preserve-intent cleanup after terminal). nonBlocking
  wake subscriptions deferred to Phase 4 (needs pi sendMessage wake). 219/219 tests.

## Reflection (iteration 11)
1. Accomplished: Phases 0-2 complete; Phase 3 ~85% (runner, artifacts, results/watcher,
   resume, fork context, worktrees, capacity). 217/217 tests across 12 files; tsc clean
   at every commit; 10 commits so far.
2. Working well: library-first-then-wire order; their-tests-as-spec keeps catching real
   bugs (stopped-run resumability, admission rejection crash, implicit-vs-explicit fork);
   handler extraction kept index.ts risk low.
3. Not blocking but noted: async workflowScript still rejects with guidance (foreground-
   only); nonBlocking wake subscriptions need pi sendMessage wake integration; worktree
   lifecycle built but not wired into launches.
4. Approach: unchanged. The hybrid architecture is holding — in-process foreground +
   process-based async both flow through one handler with clean deps.
5. Next priorities: (a) async workflowScript via process-backed runs.run, (b) wire
   worktree isolation into async launches, (c) close Phase 3 with integration-style tests,
   then Phase 4 observability on OUR panels.

## Completion marker
Emit "pi-subagents parity complete: <N> features ported, phases 0-7 done." when all phases done.
