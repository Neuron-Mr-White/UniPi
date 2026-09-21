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

### Remove `milestone`
- [ ] Delete `packages/milestone/` from the workspace
- [ ] Remove from root `package.json` workspaces manifest / bundle list / dependencies
- [ ] Remove milestone snapshots from the prefix-cache gap matrix (docs/prefix-cache-architecture.md)
- [ ] Drop `milestone` entries from the command registry / autocomplete catalog

### Remove `trajectory`
- [ ] Delete `packages/trajectory/` from the workspace
- [ ] Remove from root manifest / bundle / dependencies
- [ ] Drop `trajectory` entries from the command registry / autocomplete catalog

### Recreate `ralph` → `long-horizon`
- [ ] Delete `packages/ralph/` (keep the folder out of the workspace)
- [ ] Create `packages/long-horizon/` — long-horizon work orchestration module
- [ ] Provide `/goal` — goal-state continuation (thread goal, budget steering, completion evidence; learn from minimax-code goal module)
- [ ] Provide `/ralph` — iterative loop mode (back-compat with the ralph workflow, checklist-driven)
- [ ] Provide `/swarm` — parallel multi-agent mode (learn from maka and Devin's fleet patterns)
- [ ] Study sources: `~/Projects/Personal/archived/maka`, `~/Projects/Personal/unimportant/minimax-code` (goal module, runaway-guard), Devin public docs
- [ ] Preserve prefix-cache discipline: continuation hints cache-prefix-stable, append-only snapshots
- [ ] Update footer/info-screen/compactor references that consumed ralph iteration state
- [ ] Drop `ralph` entries from the command registry / autocomplete catalog

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
- [ ] Add centralized settings that can configure ALL unipi modules (settings are currently scattered across every package)
- [ ] Add a startup hint that shuffles every session (fun)

### 19. `web-api` — partial rewrite
- [ ] Partial rewrite; keep the functions that work (wigolo/smart-fetch backends likely stay)

### 20. `workflow` — partial rewrite / deprecate
- [ ] Make all options opt-in (models improved; not every scaffold helps anymore)
- [ ] Decide the deprecation boundary: which commands retire vs stay opt-in
- [ ] Ripple: kanboard rewrite depends on what workflow documents remain parseable

---

## Cross-cutting

- [ ] `utility` settings hub becomes the single settings surface — inventory every module's scattered settings and migrate them under it
- [ ] Prefix-cache gap matrix re-audit after milestone removal + long-horizon creation (docs/prefix-cache-architecture.md)
- [ ] pi 0.86 ownership audit: prompt-cache warming, transcript-aware prompt/tool updates, per-model compaction, deferred tool loading — delegate to pi vs keep owning
- [ ] Update the full-release chore package inventory when milestone/trajectory/ralph leave and long-horizon arrives
- [ ] Publish first `3.0.0-alpha.N` to npm under the `alpha` dist-tag when the immediate section lands
