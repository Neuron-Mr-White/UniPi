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
- [ ] agentOverrides + settings keys (subagents.defaultModel, defaultThinking, agentOverrides.<name>.{model,thinking,disabled,tools,...}) — read from OUR subagents.json, not pi settings
- [ ] Per-agent memory scopes (user/project/local)
- [ ] Agent aliases + runtime agent registration (extensions can register agents)
- [ ] enablement: preserve our rule; add their disableBuiltins
- [ ] Tests: port their agent-frontmatter.test.ts + agent discovery tests (adapted)

## Phase 2 — Foreground orchestration (in-process)
- [ ] workflowScript runtime: runs.run(key,{agent|resume,task,...}), runs.all([...]), runs.steer(key,msg,opts) — validate script (their AST rules: no nested async helpers), sandboxed VM with runs/state globals
- [ ] Sequential chaining via awaits; parallel via runs.all with concurrency
- [ ] Budgets: turnBudget {maxTurns, graceTurns, termination-deferred}, toolBudget {soft,hard,block}, usageBudget {tokens,costUsd soft/hard}
- [ ] Spawn budgets: maxSubagentSpawnsPerRun (default 64, atomic group admission, no refunds), maxSubagentSpawnsPerSession + grant-spawn-budget action, maxActiveAsyncRunsPerSession preflight
- [ ] context: fresh | fork (in-process: fresh only; fork → error advising async path, or defer to Phase 3 fork runner) — ASK USER if ambiguous
- [ ] maxSubagentDepth recursion guard + child-safety: children don't get spawn_helper unless agent tools include it; boundary instructions; fork-context filtering of parent artifacts
- [ ] timeoutMs defaults (30min foreground), toolTimeoutMs per-tool hard deadlines w/ exemptions (our tool names), known-fast built-in 5-min defaults
- [ ] maxOutput truncation {bytes, lines} + outputMode file-only
- [ ] Tests: port pi-args.test.ts, subagent-prompt-runtime, scripted-workflow tests

## Phase 3 — Async/background (process-based)
- [ ] Async runner: child pi processes (PI_SUBAGENT_PI_BINARY-style override → our env var), task delivery file|auto (EDR workaround), zero-activity SIGKILL escalation
- [ ] Run artifacts: status.json lifecycle, result files, run ids, durable receipts under ~/.unipi layout
- [ ] Result watcher: result-index scanning, slow-scan logging (resultScanLogging), async-retention cleanup
- [ ] Resume: retained children (children.list, resumable), resume-by-key in workflows, detached action:resume receipts
- [ ] Fork context: real branched child sessions (strip parent-only artifacts incl. subagent tool history), Anthropic thinking-block stripping
- [ ] Worktrees: worktree:true isolation, worktreeBaseDir, setup hooks, syntheticPaths, handoff manifests, worktree.discard with authority policy
- [ ] get_helper_result integration: waiting on async runs, nonBlocking subscriptions + wake-on-completion
- [ ] Async capacity: slots, process-terminal proof before slot release
- [ ] Tests: port async-execution, result-watcher, intercom-result-delivery, async-job-tracker integration tests (adapted)

## Phase 4 — Observability (our panels)
- [ ] FleetView: persistent panel (belowEditor/aboveEditor placement) built on our AgentWidget slot system
- [ ] Fleet inspector: /unipi:subagents-fleet overlay — browse children, read transcripts (reuse ConversationViewer), steer, stop — built as our overlay using core OverlayTheme
- [ ] inlineToolDisplay rich|summary modes; mainWindowRenderer {horizontalSpacing, compactResultMaxLines}
- [ ] foregroundDetachShortcut
- [ ] Live cards for watched foreground workflows (chatProgress auto|live-card|off)
- [ ] /unipi:subagents-doctor + doctor action: config/env/agents/capacity diagnosis
- [ ] guide action + /unipi:subagents-guide topics (docs ported to our docs/)

## Phase 5 — Missions + schedules
- [ ] Mission records: OURS ~/.unipi/missions/<project-hash>/, retainTerminal pruning, globalIndex pointers
- [ ] Automatic missions on launches; mission:false ephemeral; missionId attach; state.get/set (256KiB, lock, merge) in workflows; goal continuation notices
- [ ] Scheduled runs: durable schedules, maxPending, storeRoot, pause/resume/run/delete, delivery receipts

## Phase 6 — Intercom, acceptance, watchdog
- [ ] Native supervisor channel: contact_supervisor tool for children (need_decision/progress_update), subagent_supervisor parent tool; env-var session targeting; NO external pi-intercom dependency
- [ ] intercomBridge config: instruction injection modes, resultDelivery receipts
- [ ] Acceptance gates: inferred level, verify commands, gate shorthand, evidence collection
- [ ] Watchdog: opt-in adversarial change reviewer, scope monitoring, LSP diagnostics, child tool permissions, settings keys
- [ ] authorityPolicy: discardWorktree/destructiveCleanup/spawnBudgetGrant confirm|auto policies

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

## Completion marker
Emit "pi-subagents parity complete: <N> features ported, phases 0-7 done." when all phases done.
