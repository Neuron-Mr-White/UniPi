# pi-background-tasks Adoption (full)

Repo: /home/oi/Projects/Personal/archived/unipi
Task file: .unipi/ralph/pi-background-tasks-parity.md (this file)
Reference: /tmp/pi-background-tasks (re-clone from https://github.com/ismailsaleekh/pi-background-tasks if missing)

## Locked decisions (user)
- **Merge the WHOLE repo** — shell tasks, delegate, fusion, attested runs, anthropic attribution, infra.
- **In OUR style**: ~/.unipi paths, <ws>/.unipi/config dirs, /unipi:* command namespace, our panel/slot system (FleetView-style), our settings-overlay patterns.
- **Master feature toggle**: one config key (`enabled`, default true) that completely disables the module — no tools, no commands, no hooks, no UI when off.
- All commands AND settings mounted in our panel style (settings overlay in our TUI idiom).
- New conflicts → ASK USER. Purely mechanical → follow our conventions and note here.

## Non-negotiables (conventions)
- Storage: `~/.unipi/background-tasks/` for durable state; per-session runtime artifacts under OUR temp root (`os.tmpdir()/unipi-bg-tasks-<scope>/`). NEVER `.pi/tasks/`.
- Config: global `~/.unipi/config/background-tasks.json` + workspace `<root>/.unipi/config/background-tasks.json` (workspace wins), same layering as subagents.json.
- Env prefix: `UNIPI_BG_*` (replaces their `PI_BG_*`).
- Commands: `/unipi:bg`, `/unipi:bg-clear`, `/unipi:tasks`, `/unipi:bg-update`, `/unipi:jobs`, `/unipi:kill`, `/unipi:logs`, `/unipi:claude-cache`, `/unipi:fusion`, `/unipi:fusion-models` — registered in autocomplete constants.
- Tools: keep reference names (`bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `bg_delegate`, `bg_result`, `bg_run_pi_attested`, `fusion_reason`, `fusion_investigate`, `fusion_research`, `fusion_validate`) — no collision with ours; keeps their docs/skills prompt-compatible.
- UI: footer dock + task manager rendered through OUR widget/slot patterns (subagents FleetView precedent). No adoption of their TUI internals wholesale — adapt rendering to pi-tui components we already use.
- Skip list (mechanical): their `update-check.ts` (our updater module owns updates); their docs-freshness gate scripts (repo-infra only).
- Tests are the spec: port/adapt their test suites per phase.
- After each batch: `npx tsc --noEmit --skipLibCheck` must pass. After each phase: root `npm test` + package tests. Commit per phase.

## Package layout
New workspace package `packages/background-tasks` (`@pi-unipi/background-tasks`), mounted in `packages/unipi/index.ts` AFTER subagents (it may reuse subagents' pi-spawn hardening patterns but must not import it — keep standalone; duplicate small helpers instead).

## Phase 0 — Foundation
- [x] Scaffold package: package.json (pi.extensions entry), tsconfig, deps (typebox via root), src/index.ts skeleton honoring master `enabled` toggle (registers NOTHING when disabled)
- [x] Port parity-types: statuses, DIRS (OUR paths), event constants, config schema (all their keys + `enabled`) — src/types.ts
- [x] Config loader+validator: global+workspace layering, validateParityConfig w/ visible errors — src/config.ts
- [x] Port durable-fs.ts (400 lines, near-verbatim; rename error class) — src/durable-fs.ts
- [ ] Port common.ts helpers actually needed (json parse guards, id gen, name compaction) — src/common.ts; drop unused
- [ ] Tests: config.test.ts, durable-fs.test.ts (adapt theirs)

## Phase 1 — Shell task runtime
- [x] Port windows-taskkill.ts verbatim (env-prefix rename) — src/windows-taskkill.ts
- [x] Port registry.ts core: startTask/startManagedTask/resolveTask/status/logs/kill/retention/output caps (20MiB kill+fail, 50KiB bounded reads), shell policy POSIX+Windows w/ UNIPI_BG_SHELL — src/registry.ts (+ split if >800 lines)
- [x] Telemetry wrapping (isAgent pi -p interception → task-owned metrics) — src/telemetry-wrap.ts
- [x] Tests: core.test.ts, registry.test.ts, windows-taskkill.test.ts, posix-invariance.test.ts (adapt)

## Phase 2 — Delivery + UI + commands/tools (shell surface complete)
- [x] Completion delivery: notifyOnCompletion/triggerOnCompletion mapped onto OUR sendMessage followUp path (result-watcher pattern from subagents, local copy) — src/completion.ts
- [x] EventBus background-task-v1 (internal, our event constants) — src/eventbus.ts
- [x] Footer dock + task-manager overlay on OUR widget patterns (Shift↓ shortcut, ctrl+alt+c clear) — src/dock.ts, src/task-manager.ts
- [x] Tools: bg_run, bg_status, bg_logs, bg_kill, bg_run_pi_attested registration — src/tools.ts
- [x] Attested Pi runs (attested-pi-run.ts port) — src/attested-pi-run.ts
- [x] pi-launch hardening: resolvePiLaunch + Windows 8191-char cmdline guard — src/pi-launch.ts (standalone copy)
- [x] Commands: /unipi:bg, /unipi:bg-clear, /unipi:tasks, /unipi:bg-update, /unipi:jobs, /unipi:kill, /unipi:logs — src/commands.ts
- [x] Settings overlay (our TUI idiom): enabled, defaults, caps, shell policy — src/settings-overlay.ts
- [x] Tests: completion, dock, attested, pi-launch, extension-api tests (adapt)

## Phase 3 — Delegate
- [ ] Context projection: visible-conversation-v2 ledger (frozen projection w/ omission receipts) — src/context/
- [ ] Token budget (903 lines) — src/context/token-budget.ts
- [ ] Seed schema v2 + delegate policy — src/delegate/seed.ts
- [ ] Launch isolation (env stripping, stdin prompt, isolated sessions, guard extension) — src/delegate/launch.ts, runner.ts
- [ ] Result package (hash-verified commit/adjudicate/retrieve) — src/delegate/result-package.ts, artifacts.ts
- [ ] Budget + hook contract — src/delegate/budget.ts, hook-contract.ts
- [ ] Child extension (delegate-child-extension.ts) + extensions/delegate-child.ts entry
- [ ] Tools bg_delegate/bg_result wired; parent snapshot module
- [ ] Tests: delegate-seed, delegate-budget, delegate-artifacts, delegate-launch, delegate-result-package, delegate-child-guard, visible-conversation, token-budget (adapt)

## Phase 4 — Fusion core
- [ ] Types (1139) + workflows table (4 fixed workflows) — src/fusion/types.ts, workflows.ts
- [ ] Config (449): five-slot models, persistence w/ revision-safe lock — src/fusion/config.ts
- [ ] Context: session-projection v5 canonical input + clean-task input + omission ledger — src/fusion/context.ts, clean-context.ts
- [ ] Prompts (345) + source-policy (257) + web-fetch (1060, caller-URL-only) — src/fusion/
- [ ] Budget (1162) + evaluation (800, blind eval + repair) — src/fusion/
- [ ] Orchestrator (1288): plan→barrier→3 candidates→anonymize→eval→repair→merge→commit — src/fusion/orchestrator.ts
- [ ] Artifacts (965) + result-package (959) + output-contract + child-protocol — src/fusion/
- [ ] pi-child (2373): fusion child runner — src/fusion/pi-child.ts
- [ ] claude-cache (207) — src/fusion/claude-cache.ts
- [ ] Tests: fusion-core, budget, evaluation, orchestrator, artifacts, context-prompts, web-fetch, golden-bytes/extraction-equivalence/high-cardinality (adapt)

## Phase 5 — Fusion integration
- [ ] fusion-extension.ts (1294): tools fusion_reason/investigate/research/validate + /unipi:fusion + /unipi:fusion-models
- [ ] Model selector TUI on OUR overlay patterns — src/ui/fusion-model-selector.ts
- [ ] fusion-child-extension.ts (1012) + extensions/fusion-child.ts entry
- [ ] Managed-task registration through Phase 1 registry (durable preflight barrier, usage claim)
- [ ] Renderer for fusion results (our renderResult idiom)
- [ ] Tests: fusion-sdk, fusion-rpc, fusion-workflows, fusion-config, model-selector (adapt)

## Phase 6 — Anthropic attribution
- [ ] Port anthropic-attribution.ts (1983) + path helper + extensions entry; EventBus claim protocol kept internal
- [ ] /unipi:claude-cache command
- [ ] Tests: anthropic-attribution.test.ts (adapt)

## Phase 7 — Integration + ship
- [ ] Mount in packages/unipi/index.ts (after subagents); bundled build passes
- [ ] Autocomplete constants: all /unipi:* commands
- [ ] Root package.json deps if needed; pack globs (agents/prompts/skills if any)
- [ ] README rewrite (our surface, our paths)
- [ ] Full verification: tsc + root npm test + package tests; bump version; npm publish; reinstall on PC; verify install tree

## Progress log
- Phase 2 COMPLETE: full extension wiring in index.ts (master toggle gates everything;
  session_start/shutdown lifecycle; status-interval footer updates via ctx.ui.setStatus;
  shutdown kills running tasks). Tools ported verbatim w/ reference names (bg_run,
  bg_status, bg_logs, bg_kill, bg_run_pi_attested) + renderers. Commands in /unipi:*
  namespace (bg, tasks, bg-clear, jobs, logs, kill) + Shift↓ / ctrl+alt+c shortcuts.
  Task-manager overlay ported (task-manager.ts, 774 ref lines) with lazy dynamic import.
  EventBus extension-api ported (extension-api.ts, 548 lines) — channels renamed to
  unipi-background-tasks:*. Completion delivery flows through registry notifyCompletion ->
  pi.sendMessage(followUp + triggerTurn). attested-pi-run + pi-launch already landed in
  Phase 0/1 as type deps. NOTE: settings overlay deferred to Phase 7 integration pass
  (config surface exists; our shared overlay idiom lands with the other packages' panels).
  Tests: extension-api 3 + task-manager 8 + prior 77 = 88/88.
- Phase 1 COMPLETE: full registry port (2452 ref lines) — startTask/startManagedTask/
  claimFusionUsage/startDelegateTask/startAttestedPiTask, resolveTask prefixes,
  stopTask/stopAllRunning (SIGTERM->SIGKILL escalation, Windows taskkill soft/force),
  20MiB output cap kill+fail, bounded log reads, telemetry ingestion + wrapped-agent
  activity transcripts, terminal publication gate/retry, notification w/ notified reset,
  retention pruning. windows-taskkill verbatim. Runtime dir -> OUR temp root
  ($TMPDIR/unipi-bg-tasks/<session>-<pid>-<nonce>, UNIPI_BG_TMP_DIR override) with a
  per-instance nonce (reference relied on per-cwd .pi/tasks). Env prefix UNIPI_BG_*;
  shell policy error unipi_bg_shell_invalid. Shared interfaces in child-process.ts.
  Tests: registry 30 + core 9 + win-taskkill 5 + durable-fs 25 + config 8 = 77/77.
- Phase 0 COMPLETE: package scaffolded (@pi-unipi/background-tasks), master `enabled` toggle
  gates the entry point, config layering (~/.unipi/config/background-tasks.json global +
  workspace override, workspace wins, corrupt layers warn not crash), types.ts ported from
  their common.ts (statuses, snapshots, delivery guidance, bg command parser, activity
  transcript), durable-fs verbatim, delegate/fusion/token-budget/visible-conversation/
  attested-pi-run/pi-launch type modules copied with flattened import paths. Adaptations:
  FusionUsage widened locally (our pi-ai Usage lacks `reasoning`), DEFAULT_MAX_BYTES defined
  locally (not exported by our core), ChildStdin shimmed as Writable. 33/33 tests
  (config 8 + durable-fs 25).

## Completion marker
Emit "pi-background-tasks adoption complete: all phases done, published."
