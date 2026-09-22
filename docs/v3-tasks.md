# v3 Tasks

Planning reference for the v3 rework. Branch: `v3` · Version: `3.0.0-alpha.0` · Created: 2026-09-20.

Base analysis: minimax-code harness comparison (loop machinery, goal continuation, provider wire fixes) + pi 0.86 SDK capabilities (cache warming, per-model compaction, deferred tool loading).

## Status Legend

- **rewrite** — remove and recreate from scratch
- **removal** — delete the package entirely
- **partial** — keep the core, rework parts
- **ux** — keep architecture, improve experience
- **keep** — no planned changes

---

## Immediate — do now

Removals and recreations are green-lit to start immediately.

### Remove `milestone` ✅ (2026-09-20)
- [x] Delete `packages/milestone/` from the workspace
- [x] Remove from root `package.json` workspaces manifest / bundle list / dependencies (deps + `pi.skills` entry + lockfile)
- [x] Remove milestone snapshots from the prefix-cache gap matrix (docs/prefix-cache-architecture.md)
- [x] Drop `milestone` entries from the command registry / autocomplete catalog (provider aliases incl. `ms`/`goal`, package list, colors, labels, command descriptions)
- [x] Remove `formatMilestoneSnapshot` case from tests/prefix-provider-payload.test.js
- [x] Remove `MODULES.MILESTONE`, `MILESTONE_COMMANDS`, `MILESTONE_DIRS` from core/constants.ts + updater readme map

### Remove `trajectory` ✅ (2026-09-20)
- [x] Delete `packages/trajectory/` from the workspace
- [x] Remove from root manifest / bundle / dependencies (deps + lockfile)
- [x] Drop `trajectory` entries from the command registry / autocomplete catalog
- [x] Remove `createUnipiTracer` wiring from the umbrella — `packages/unipi/index.ts` now passes `pi` straight through (tracer was trajectory-only observability; no other consumer)

### Recreate `ralph` → `long-horizon` ✅ (2026-09-20, d09ff2d..b7bbb02)
- [x] Delete `packages/ralph/` (umbrella, deps, pi.skills, lockfile, workflow bridge, autocomplete, mise — all references cleaned)
- [x] Create `packages/long-horizon/` — mode-gated orchestration: TypeSafe jev judge (goal|ralph|swarm|graph|none), gate with payload tool filtering + defense-in-depth blocking, one-owner-per-session with max-1 park + control leases
- [x] Provide `/goal` — mcode propose+verify spine: create/get/update tools, kickoff-once contract + one-line hints, baseline-pending token budget, stall-neutral-on-verifier-failure, blocked 3-turn threshold, waiting backoff, wrap-up-once, 5-turn terminal audit, independent evaluator with missing[] feedback
- [x] Provide `/ralph` — task-file loop re-hosted on the goal machine (same .unipi/ralph files; gains budgets + verifier on all-checked); ralph_done lease-guarded; footer RALPH_* events preserved
- [x] Provide `/swarm` — Maka prescription over spawn_helper/bg_delegate: ledger + swarm_report/status/yield, all-settled auto-close, orchestration block
- [x] Provide `/graph` (staged v1) — declare-time cycle validation, topological waves, input frontiers (committed summaries, never restated conclusions), failure blocking + abort cascade
- [x] Runaway guard — six step-end detectors, steer-once-per-turn with anti-poisoning text
- [x] Study sources: maka (goal-evaluator/GoalManager/agent-graph/swarm/scheduled-task) + minimax-code (thread-goal/verifier/runaway-guard) — docs/long-horizon-study.md, design docs/long-horizon-design.md
- [x] Preserve prefix-cache discipline: kickoff-once + one-line hints, static-per-mode system fragment (status rides tail messages), order-preserving identity-stable tool filtering
- [x] Footer keeps its ralph segment (engine emits RALPH_* events); todowrite emits LONG_HORIZON_TODO_UPDATED
- [x] Autocomplete registry: goal/ralph/swarm/graph commands + freed `goal` alias → long-horizon
- Plus: todowrite (mcode-style), 122 package tests + full suite green, mise run sandbox, scenarios suite (design §6 matrix)

---

## Package Work

### 1. `ask-user` — improve implementation
- [ ] Audit current implementation for gaps (timeout semantics, `recommended` options, `requiresExplicitResponse` — cf. minimax-code goal prompt conventions)
- [ ] Improve reliability and ergonomics of structured answers

### 2. `command-enchantment` — maintenance
- [ ] Touched along the way anyway (registry updates from removals/renames); no dedicated work planned

### 3. `background-tasks` — ux
- [ ] Improve dock readability and interaction
- [ ] Improve wake-line / notification UX

### 4. `btw` — ux
- [ ] Improve side-conversation UX (discovery, switching, context visibility)

### 5. `compactor` — choices
- [ ] Provide compaction choices (let the user pick strategy: zero-LLM vs LLM summary vs pi-native per-model budgets)
- [ ] Reconcile ownership with pi 0.86 per-model compaction budgets + transcript-aware updates

### 6. `core` — keep
- [ ] No planned changes (foundation stays stable; version-compare prerelease fix already landed)

### 7. `footer` — configurability
- [ ] Improve configurability (segments, layout, per-module toggles)

### 8. `fusion` — ux
- [ ] Improve pairing/picker/runtime UX

### 9. `image` — improve + fix
- [ ] Improve functionality; fix broken paths (model list, generation, vision analysis)

### 10. `info-screen` — ux
- [ ] Improve dashboard UX

### 11. `input-shortcuts` — onboarding
- [ ] Improve onboarding (discoverability of chords, first-run hints)

### 12. `kanboard` — rewrite
- [ ] Full rewrite of the board/parsers/UI layer
- [ ] Decide relationship to workflow's deprecation (what document formats should v3 boards parse?)

### 13. `mcp` — keep
- [ ] Ok for now

### 14. `memory` — improve
- [ ] More improvement: compatibility (backends, migration) and UX
- [ ] Continue MemPalace compatibility work where gaps remain

### 15. `notify` — keep
- [ ] Ok for now

### 16. `subagents` — partial rewrite
- [ ] Partial rewrite; improve compatibility with the rest of unipi

### 17. `updater` — keep + optional ux
- [ ] Ok for now; optional UX polish later

### 18. `utility` — ux + settings hub
- [ ] UX improvements
- [x] Add centralized settings that can configure ALL unipi modules — `/unipi:settings` hub shipped (bc85981): core schema+hub, utility command; long-horizon (incl. judge.apiKey secret, env-free), footer, compactor, ask-user, notify, autocomplete, utility-badge adopted onto the engine
- [ ] Add a startup hint that shuffles every session (fun)

### 19. `web-api` — partial rewrite
- [ ] Partial rewrite; keep the functions that work (wigolo/smart-fetch backends likely stay)

### 20. `workflow` — partial rewrite / deprecate
- [ ] Make all options opt-in (models improved; not every scaffold helps anymore)
- [ ] Decide the deprecation boundary: which commands retire vs stay opt-in
- [ ] Ripple: kanboard rewrite depends on what workflow documents remain parseable

---

## Cross-cutting

- [x] `utility` settings hub is the single settings surface for ALL 15 settings-bearing modules (mcp excluded by design — server registry is content, not settings). UX per spec: space/tab/inline-prefilled-inputs/enum-custom/searchable 5-row model picker, instant writes, global+project scopes. POLISHED: fits-screen viewport with scroll indicators, uniform full-width paint (plain-text columns, style-after-measure), matchesKey router (all terminal encodings incl. herdr/kitty), per-row hints. Verified live on coffee (pi 0.87) + PC (0.86).
- [ ] Prefix-cache gap matrix re-audit after milestone removal + long-horizon creation (docs/prefix-cache-architecture.md)
- [ ] pi 0.86 ownership audit: prompt-cache warming, transcript-aware prompt/tool updates, per-model compaction, deferred tool loading — delegate to pi vs keep owning
- [ ] Update the full-release chore package inventory when milestone/trajectory/ralph leave and long-horizon arrives
- [ ] Publish first `3.0.0-alpha.N` to npm under the `alpha` dist-tag when the immediate section lands
