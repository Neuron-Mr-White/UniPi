# Build `packages/long-horizon/` — v3 long-horizon module

Authoritative design: `docs/long-horizon-design.md` · mechanisms: `docs/long-horizon-study.md`.
Decisions: mcode goal spine (propose+verify) · Maka swarm+graph · ralph re-hosted on the
coordinator · mode-gated tool exposure · TypeSafe jev judge · max-1 parked owner ·
sidekick/bg_run = infrastructure, spawn_helper/bg_delegate = delegation.

## Phase 1 — Foundation ✅ (d09ff2d)
- [x] Scaffold `packages/long-horizon/` (notify conventions; root typecheck covers workspaces — no per-package tsconfig)
- [x] `src/modes.ts` — five-mode registry with control-tools/prompt-fragment/owner-kind/delegation mapping
- [x] `src/owner.ts` — owner coordinator: one active owner, max-1 park (refusal), control leases, revision checkpoints, bounded history, crash-restore; 12 tests
- [x] Config survey: two patterns exist (notify per-package file vs ask-user shared ~/.pi/agent/settings.json `unipi.*`). Picked shared-file: `unipi.longHorizon` key (settings.ts), lazy path resolution (module-level path constants break test isolation — ask-user has this latent flaw), deep-merge repair; 4 tests

## Phase 2 — Gate + judge
- [x] `src/judge/typesafe.ts` — POST /v1/systemone client: {state, model:"jev-latest", questions:{mode: choice{goal,ralph,swarm,graph,none}, decomposable: noul}} → {choice, confidence}; injectable fetch; provider typesafe|openrouter (baseUrl+key from settings/env TYPESAFE_API_KEY | OPENROUTTER_API_KEY); 1s timeout, fail-open
- [x] `src/judge/resolve.ts` — confidence gate (threshold, default 0.6; low → owner-if-active else default), single-entry cache (prompt hash → decision, TTL), judge runs on NEW user messages only
- [x] `src/gate.ts` — resolution ladder: explicit /unipi:<mode> > active owner > judge > default(goal when judge off, none never a judge-off default); tool surface switching via pi 0.86 deferred tools; orchestration prompt fragment injection + owner status line; `mode-resolved` event
- [x] Commands: /unipi:goal, /unipi:ralph, /unipi:swarm, /unipi:graph (<prompt> = turn override; `resume`, `clear`, `status` subcommands), /unipi:continue (resume owner)
- [x] Unit tests: resolution ladder all branches, judge fixtures (record/replay, no network), fail-open paths

## Phase 3 — Goal mode (mcode spine)
- [x] `src/tools/goal.ts` — create_goal / get_goal / update_goal (mcode schemas: update_goal mode "status"|"token_budget" with expected_goal_id+expected_updated_at CAS); lease-guarded; create_goal rejected while goal parked/unfinished
- [x] `src/engine/goal-state.ts` — statuses active|waiting|paused|complete|blocked|budget_limited|usage_limited + reason taxonomy (mcode's 25); revision checkpoints; baseline-pending token budget; stall counter (neutral on evaluator failure); iteration cap
- [ ] `src/engine/continuation.ts` — turn-end → settle → continue|wait|stop; kickoff contract ONCE (cache-stable, XML-escaped objective) then one-line hints; NO_PROGRESS/NO_TOOL nudges; 5-turn terminal audit; waiting backoff 5s×2ⁿ cap 5min; wrap-up turn on budget exhaustion keyed f(goalId, epoch)
- [x] `src/engine/verifier.ts` — evaluator adapter: bounded evidence brief (objective digest, claim, changed files/commands ≤4000 chars, recent tail 5×800), verdict met|not_met+missing[]|impossible|inconclusive, notMetStreak, fail-open-neutral on error; injectable for tests
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
