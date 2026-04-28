---
title: "Badge Settings TUI & Generation Fix — Implementation Plan"
type: plan
date: 2026-04-28
workbranch:
specs:
  - .unipi/docs/specs/2026-04-28-badge-settings-tui-design.md
---

# Badge Settings TUI & Generation Fix — Implementation Plan

## Overview

Fix the broken badge name generation (hardcoded model fallback), create a proper TUI settings overlay with model selector in the utility package, add a shared model cache so TUI can list available models without `ctx.modelRegistry`, and clean up the misplaced kanboard settings overlay.

## Tasks

- completed: Task 1 — Create Model Cache (`packages/core/model-cache.ts`)
  - Description: Add `readModelCache()` and `writeModelCache()` functions in the core package. Cache stores `{ updatedAt, models: [{provider, id, name?}] }` at `~/.unipi/config/models-cache.json`. Export from `packages/core/index.ts`.
  - Dependencies: None
  - Acceptance Criteria: Functions compile, exports visible from `@pi-unipi/core`. `readModelCache()` returns empty array when no file exists. `writeModelCache()` creates directory if needed.
  - Steps:
    1. Create `packages/core/model-cache.ts` with `CachedModel`, `ModelCache` interfaces and `readModelCache()` / `writeModelCache()` functions (see spec for code)
    2. Add `export * from "./model-cache.js";` to `packages/core/index.ts`

- completed: Task 2 — Update Badge Settings Schema (`packages/utility/src/tui/badge-settings.ts`)
  - Description: Add `generationModel: string` field to `BadgeSettings` interface. Default to `"inherit"`. Update `readBadgeSettings` to handle the new field.
  - Dependencies: None
  - Acceptance Criteria: `BadgeSettings` includes `generationModel`. Reading old config (without field) returns default `"inherit"`. `formatBadgeSettings` shows the model field.
  - Steps:
    1. Add `generationModel: string` to `BadgeSettings` interface with JSDoc
    2. Add `generationModel: "inherit"` to `DEFAULT_SETTINGS`
    3. In `readBadgeSettings`, add fallback: `generationModel: typeof parsed.generationModel === "string" ? parsed.generationModel : DEFAULT_SETTINGS.generationModel`
    4. Update `formatBadgeSettings` to show the model setting row

- completed: Task 3 — Create Badge Settings TUI Overlay (`packages/utility/src/tui/badge-settings-tui.ts`)
  - Description: New TUI component with: auto-generate toggle, badge-enabled toggle, generation model selector (inline scrollable list from cache). Uses `Component` class pattern (matching `KanboardSettingsOverlay` and `SettingsOverlay`). Vim navigation (j/k), Space toggles booleans, Enter opens/selects model, Esc closes. Auto-saves on every change.
  - Dependencies: Task 1 (model cache), Task 2 (generationModel field)
  - Acceptance Criteria: Overlay renders with 3 settings (autoGen, badgeEnabled, generationModel). Model picker shows "inherit" + all cached models. Space toggles boolean settings, Enter selects model, Esc closes. All changes auto-save to `.unipi/config/badge.json`.
  - Steps:
    1. Create `packages/utility/src/tui/badge-settings-tui.ts` following the `KanboardSettingsOverlay` pattern (implements `Component` with `render`, `handleInput`, `invalidate`, `onClose`)
    2. Import `readModelCache` from `@pi-unipi/core` for model list
    3. Import `readBadgeSettings`, `writeBadgeSettings` from `./badge-settings.js`
    4. Implement two modes: "settings" (3 items) and "model-picker" (inline list of models)
    5. Settings mode: j/k navigates, Space toggles autoGen/badgeEnabled, Enter on model row enters model-picker, Esc closes and saves
    6. Model-picker mode: j/k scrolls model list, Enter selects and returns to settings, Esc cancels selection
    7. Auto-save on every change (not just on close) — writes full settings object
    8. Render with box-drawing characters, cyan borders, matching existing overlay style

- completed: Task 4 — Add `/unipi:badge-settings` Command & Export
  - Description: Add a `/unipi:badge-settings` command that opens the TUI overlay. Keep existing `/unipi:badge-toggle` for backward compatibility. Export `readBadgeSettings` from the utility package index.
  - Dependencies: Task 3 (TUI overlay)
  - Acceptance Criteria: `/unipi:badge-settings` opens TUI overlay in terminal UI. Non-UI fallback shows text settings. `readBadgeSettings` is importable from `@pi-unipi/utility`.
  - Steps:
    1. In `packages/utility/src/commands.ts`, add new command registration for `badge-settings` using `UTILITY_COMMANDS.BADGE_SETTINGS` (or add the constant)
    2. In the command handler, use `ctx.ui.custom()` with `overlay: true`, same pattern as kanboard's settings command
    3. Import `BadgeSettingsTui` from `./tui/badge-settings-tui.js`
    4. In `packages/utility/src/index.ts`, add `export { readBadgeSettings } from "./tui/badge-settings.js";`
    5. Add `badge-settings` to `ALL_COMMANDS` array

- completed: Task 5 — Write Model Cache on Session Start
  - Description: In `packages/utility/src/index.ts` session_start handler, write available models to the cache file using `writeModelCache` from `@pi-unipi/core`.
  - Dependencies: Task 1 (model cache)
  - Acceptance Criteria: On session start, `~/.unipi/config/models-cache.json` is written with all models from `ctx.modelRegistry`. Cache file contains `{ updatedAt, models: [{provider, id, name?}] }`.
  - Steps:
    1. In `packages/utility/src/index.ts`, inside the `session_start` handler, after existing code: import `writeModelCache` from `@pi-unipi/core`
    2. Check `ctx.modelRegistry` exists, get models via `getAvailable?.() ?? getAll()`
    3. Map to `{ provider, id, name }` and call `writeModelCache(models)`

- completed: Task 6 — Fix Generation Flow in Subagents
  - Description: Update `packages/subagents/src/index.ts` BADGE_GENERATE_REQUEST handler to read `generationModel` from badge settings instead of hardcoding `openai/gpt-oss-20b`. If set to "inherit" or unset, pass `undefined` to inherit parent model.
  - Dependencies: Task 2 (generationModel field), Task 4 (export readBadgeSettings)
  - Acceptance Criteria: Generation uses configured model from badge settings. "inherit" or unset → uses parent model. Configured model → resolves via modelRegistry. If resolution fails → falls back to parent. No more hardcoded `openai/gpt-oss-20b`.
  - Steps:
    1. In `packages/subagents/src/index.ts`, inside the BADGE_GENERATE_REQUEST handler
    2. Replace `const modelInput = "openai/gpt-oss-20b"` with dynamic read: `const { readBadgeSettings } = await import("@pi-unipi/utility"); const settings = readBadgeSettings();`
    3. Set `modelInput = settings.generationModel === "inherit" ? undefined : settings.generationModel;`
    4. Keep existing model resolution logic (resolveModel check), but only run if `modelInput` is defined
    5. If resolution fails, `resolvedModel` stays `undefined` → inherits parent

- completed: Task 7 — Delete Kanboard Settings Overlay
  - Description: Remove `packages/kanboard/tui/settings-overlay.ts` and the `/unipi:kanboard-settings` command from `packages/kanboard/commands.ts`. The badge settings TUI in utility now handles this.
  - Dependencies: Task 4 (new settings command exists)
  - Acceptance Criteria: `packages/kanboard/tui/settings-overlay.ts` is deleted. `/unipi:kanboard-settings` command is removed from kanboard commands. Kanboard still compiles without the overlay import.
  - Steps:
    1. Delete `packages/kanboard/tui/settings-overlay.ts`
    2. In `packages/kanboard/commands.ts`, remove the `import { KanboardSettingsOverlay }` line
    3. In `packages/kanboard/commands.ts`, remove the `kanboard-settings` command registration block (lines ~86-122)
    4. Verify kanboard compiles (`cd packages/kanboard && npx tsc --noEmit`)

## Sequencing

```
Task 1 (model-cache)  ──────────────────────────────┐
                                                     ├─→ Task 5 (write cache on start)
Task 2 (badge-settings schema) ───┐                  │
                                   ├─→ Task 3 (TUI) ─┤
Task 4 (command + export) ────────┘     │            │
                                         │            │
Task 6 (fix generation) ←──────────────┘            │
                                                     │
Task 7 (delete kanboard overlay) ←───────────────────┘
```

- Tasks 1 and 2 can be done in parallel (no deps between them)
- Task 3 needs both 1 and 2
- Task 4 needs 3
- Task 5 needs 1 (can run parallel with 3/4)
- Task 6 needs 2 and 4 (readBadgeSettings export)
- Task 7 needs 4 (new settings command exists as replacement)

## Risks

- **Model registry shape:** `getAvailable()` may not exist on all registry implementations. Using `getAvailable?.() ?? getAll()` as fallback mitigates this.
- **Circular imports:** `subagents` importing from `@pi-unipi/utility` — both are sibling packages under `packages/`. Dynamic `await import()` avoids top-level circular issues.
- **Existing badge.json files:** Users with existing config files won't have `generationModel`. The `readBadgeSettings` fallback to `"inherit"` handles this gracefully.
