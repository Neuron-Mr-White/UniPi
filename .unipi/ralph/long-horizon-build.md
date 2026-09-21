# Build `packages/long-horizon/` — v3 long-horizon module

Authoritative design: `docs/long-horizon-design.md` · mechanisms: `docs/long-horizon-study.md`.
Decisions: mcode goal spine (propose+verify) · Maka swarm+graph · ralph re-hosted on the
coordinator · mode-gated tool exposure · TypeSafe jev judge · max-1 parked owner ·
sidekick/bg_run = infrastructure, spawn_helper/bg_delegate = delegation.

## Phase 1 — Foundation
- [ ] Scaffold `packages/long-horizon/` (package.json @pi-unipi/long-horizon 3.0.0-alpha.0, tsconfig, index.ts, workspace wiring; follow an existing small package like notify for conventions)
- [ ] `src/modes.ts` — mode registry: id (goal|ralph|swarm|graph|none), label, control tools[], prompt fragment id, owner kind
- [ ] `src/owner.ts` — automation-owner state machine: one active owner per session, statuses (active/paused/terminal × reasons), control lease {ownerId, generation}, revision checkpoint, max-1 park slot with refusal, persistence to `.unipi/long-horizon/state.json` on every transition, `owner-changed` event emission; unit tests
- [ ] Survey existing per-package config patterns (ask-user config.ts, notify, footer, compactor presets) → pick shared approach; define `long_horizon.*` settings schema (judge.enabled/provider/model/baseUrl/threshold, default_mode, verifier.model) designed for the future `/unipi:settings` hub — no new scattered command

## Phase 2 — Gate + judge
- [ ] `src/judge/typesafe.ts` — POST /v1/systemone client: {state, model:"jev-latest", questions:{mode: choice{goal,ralph,swarm,graph,none}, decomposable: noul}} → {choice, confidence}; injectable fetch; provider typesafe|openrouter (baseUrl+key from settings/env TYPESAFE_API_KEY | OPENROUTTER_API_KEY); 1s timeout, fail-open
- [ ] `src/judge/resolve.ts` — confidence gate (threshold, default 0.6; low → owner-if-active else default), single-entry cache (prompt hash → decision, TTL), judge runs on NEW user messages only
- [ ] `src/gate.ts` — resolution ladder: explicit /unipi:<mode> > active owner > judge > default(goal when judge off, none never a judge-off default); tool surface switching via pi 0.86 deferred tools; orchestration prompt fragment injection + owner status line; `mode-resolved` event
- [ ] Commands: /unipi:goal, /unipi:ralph, /unipi:swarm, /unipi:graph (<prompt> = turn override; `resume`, `clear`, `status` subcommands), /unipi:continue (resume owner)
- [ ] Unit tests: resolution ladder all branches, judge fixtures (record/replay, no network), fail-open paths

## Phase 3 — Goal mode (mcode spine)
- [ ] `src/tools/goal.ts` — create_goal / get_goal / update_goal (mcode schemas: update_goal mode "status"|"token_budget" with expected_goal_id+expected_updated_at CAS); lease-guarded; create_goal rejected while goal parked/unfinished
- [ ] `src/engine/goal-state.ts` — statuses active|waiting|paused|complete|blocked|budget_limited|usage_limited + reason taxonomy (mcode's 25); revision checkpoints; baseline-pending token budget; stall counter (neutral on evaluator failure); iteration cap
- [ ] `src/engine/continuation.ts` — turn-end → settle → continue|wait|stop; kickoff contract ONCE (cache-stable, XML-escaped objective) then one-line hints; NO_PROGRESS/NO_TOOL nudges; 5-turn terminal audit; waiting backoff 5s×2ⁿ cap 5min; wrap-up turn on budget exhaustion keyed f(goalId, epoch)
- [ ] `src/engine/verifier.ts` — evaluator adapter: bounded evidence brief (objective digest, claim, changed files/commands ≤4000 chars, recent tail 5×800), verdict met|not_met+missing[]|impossible|inconclusive, notMetStreak, fail-open-neutral on error; injectable for tests
- [ ] Compactor integration: kickoff contract + owner status in preserved sections; post-compaction status fragment re-injection
- [ ] Unit tests: state machine transitions, CAS rejections, settlement math, verifier fixtures, crash/repair (reload state.json, retracted-turn recovery fragment)

## Phase 4 — todowrite + ralph mode
- [ ] `src/tools/todo.ts` — todowrite snapshot-replace (pending/in_progress/completed/cancelled + priority, one in_progress, "updating ≠ completing"); footer/info-screen render from events
- [ ] Re-host ralph on the coordinator: keep task-file methodology (.unipi/ralph/ task files, iteration cadence, reflection); ralph_start stays command-side; ralph_done becomes lease-guarded iteration yield; gains stall cap + token budget + completion claim → verifier when all items checked; migration from packages/ralph state files
- [ ] Remove `packages/ralph/` + all references (umbrella, root pi.skills, autocomplete, README, v3-tasks.md) once long-horizon ralph mode passes tests

## Phase 5 — Swarm + runaway guard
- [ ] `src/tools/swarm.ts` — swarm_status projection (item statuses → running|needs_attention|settled) + swarm_yield; orchestration block (Maka swarm-mode prompt adapted to spawn_helper/bg_delegate); claim-before-dispatch (idempotency key per item); replace-failed; finish + dedupe + synthesize; wakes via background-tasks notifications, user-first ordering
- [ ] `src/engine/runaway.ts` — step-end detectors (exact_action_repeat, exact_result_repeat, same_error_family, polling_repeat, unchanged_progress_repeat, abab) → steer-once-per-turn nudge with anti-poisoning text; remindAfter ≥3
- [ ] Unit tests: swarm lifecycle with scripted bg tasks, runaway detector fixtures

## Phase 6 — Graph (staged v1) + polish
- [ ] `src/tools/graph.ts` — single-wave scheduling with input frontiers over committed results (real but minimal graph; full DAG + finish semantics later); /unipi:graph first-class
- [ ] Sandbox: `mise run sandbox` task (pi + long-horizon only; judge on if key, else fail-open) + scripted-provider scenario suite (the 8 scenarios in design §6) + judge record/replay fixtures
- [ ] Umbrella wiring (packages/unipi/index.ts), root package.json deps + pi.skills entry, autocomplete registry (goal/ralph/swarm/graph commands incl. freed `goal` alias), README section, docs/v3-tasks.md checkpoints, full suite + typecheck green
- [ ] Memory: store implementation-learned patterns

## Guardrails
- Prefix-cache discipline everywhere: deterministic rendering, kickoff-once, deferred tool activation never rewrites prefix
- Zero network in CI (fixtures only); sandbox task is the only network path
- Follow repo conventions (defineTool pattern, event bus, tryRead/writeJson utils from @pi-unipi/core)
- Each phase: typecheck + package tests green before marking done
