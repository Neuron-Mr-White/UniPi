---
title: "ntfy Project-Level Config — Implementation Plan"
type: plan
date: 2026-05-01
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-01-ntfy-project-level-design.md
---

# ntfy Project-Level Config — Implementation Plan

## Overview

Add project-level ntfy configuration so different projects can use different ntfy topics/priorities. Introduces a dedicated `ntfy.json` file at both global and project scope with full override semantics, a new `ntfy-config.ts` module for resolution, scope selection in the setup wizard, and scope display in the settings overlay.

## Tasks

- completed: Task 1 — Create ntfy-config.ts module
  - Description: New module at `packages/notify/ntfy-config.ts` with four exports: `loadNtfyConfig(cwd)`, `saveNtfyConfig(scope, cwd, config)`, `getNtfyConfigScope(cwd)`, `migrateFromLegacyConfig()`. Resolution: project `<cwd>/.unipi/config/notify/ntfy.json` → global `~/.unipi/config/notify/ntfy.json` → defaults. Invalid JSON logs warning and falls back to next level. Migration copies ntfy section from config.json to ntfy.json once if global ntfy.json doesn't exist but config.json has ntfy settings.
  - Dependencies: None
  - Acceptance Criteria: Module exports all four functions. `loadNtfyConfig` returns project config when project ntfy.json exists, global config when only global exists, defaults when neither exists. Invalid JSON falls back gracefully. Migration writes ntfy.json from config.json ntfy section. TypeScript compiles with zero errors.
  - Steps:
    1. Create `packages/notify/ntfy-config.ts` with imports (fs, path, os, types)
    2. Define `NtfyConfig` shape (reuse from types.ts or define standalone)
    3. Implement `getGlobalNtfyPath()` and `getProjectNtfyPath(cwd)` helpers
    4. Implement `readNtfyJson(filePath)` — read + parse with try/catch, return null on ENOENT, warn on parse error
    5. Implement `loadNtfyConfig(cwd)` — try project, then global, then defaults
    6. Implement `saveNtfyConfig(scope, cwd, config)` — write to chosen scope, mkdir if needed
    7. Implement `getNtfyConfigScope(cwd)` — check project exists → "project", global exists → "global", else "none"
    8. Implement `migrateFromLegacyConfig()` — check global ntfy.json missing + config.json has ntfy settings → write ntfy.json
    9. Export all four functions + NtfyConfig type

- completed: Task 2 — Wire cwd through dispatch chain
  - Description: Capture `process.cwd()` at session_start in index.ts, store it, and pass through to `dispatchNotification` and `sendToPlatform`. Update function signatures in events.ts to accept `cwd` parameter. Update all call sites in events.ts, tools.ts.
  - Dependencies: None
  - Acceptance Criteria: `dispatchNotification` and `sendToPlatform` accept `cwd: string` parameter. All call sites pass cwd. ntfy case in `sendToPlatform` uses `loadNtfyConfig(cwd)` instead of `config.ntfy`. TypeScript compiles with zero errors.
  - Steps:
    1. In `events.ts`: add `cwd` param to `dispatchNotification` signature (after `config`)
    2. In `events.ts`: add `cwd` param to `sendToPlatform` signature (after `config`)
    3. In `events.ts`: update ntfy case in `sendToPlatform` to call `loadNtfyConfig(cwd)` and use returned config for serverUrl/topic/priority/token
    4. In `events.ts`: thread `cwd` from `dispatchNotification` to `sendToPlatform` calls
    5. In `events.ts`: thread `cwd` through all `dispatchNotification` calls inside `registerEventListeners` closures
    6. In `index.ts`: capture `process.cwd()` at session_start, store in module-level variable, pass to `registerEventListeners`
    7. In `tools.ts`: capture `process.cwd()` in tool execute handler, pass to `dispatchNotification`
    8. In `commands.ts`: update `/unipi:notify-test` to use `loadNtfyConfig(process.cwd())` for ntfy resolution

- completed: Task 3 — Add scope selection to ntfy-setup wizard
  - Description: Insert a new "scope" selection phase after instructions in `ntfy-setup.ts`. User chooses Global or Project. If Project selected, ensure `.unipi/config/notify/` dir exists in cwd. All subsequent steps save to chosen scope via `saveNtfyConfig`. Re-running wizard pre-selects current scope and pre-fills from chosen scope.
  - Dependencies: Task 1
  - Acceptance Criteria: Wizard shows scope selection after instructions. Default is "Global". Selecting "Project" saves to `<cwd>/.unipi/config/notify/ntfy.json`. Selecting "Global" saves to `~/.unipi/config/notify/ntfy.json`. Re-running wizard pre-selects current scope. Pre-fills existing values from chosen scope. TypeScript compiles with zero errors.
  - Steps:
    1. Add `"scope"` to `SetupPhase` union type
    2. Add `scope: "global" | "project"` field (default "global")
    3. In constructor: determine current scope via `getNtfyConfigScope(process.cwd())`, pre-select, pre-fill from `loadNtfyConfig(process.cwd())`
    4. Insert scope phase after instructions — on Enter from instructions, go to "scope" instead of "server-url"
    5. Add scope phase to `handleInput` — Up/Down to select, Enter to confirm, Esc to cancel
    6. After scope selection, ensure project dir exists if "project" selected, then proceed to "server-url"
    7. Update `saveConfig()` to use `saveNtfyConfig(scope, process.cwd(), config)` instead of `updateConfig`
    8. Add scope phase to `render()` — show "Global (all projects)" and "Project (this project only)" with arrow selection
    9. Update instructions phase to show pre-fill info based on chosen scope

- completed: Task 4 — Update settings overlay to show ntfy scope
  - Description: Update the ntfy detail line in `settings-overlay.ts` to show topic, priority, and scope (`[project]` or `[global]` or "Not configured"). Calls `getNtfyConfigScope(cwd)` and `loadNtfyConfig(cwd)` on init.
  - Dependencies: Task 1
  - Acceptance Criteria: ntfy line in Platforms tab shows `● ntfy Topic: my-project-alerts · P3 · [project]` or `○ ntfy Not configured`. Scope label matches actual config source. TypeScript compiles with zero errors.
  - Steps:
    1. In constructor: call `loadNtfyConfig(process.cwd())` and `getNtfyConfigScope(process.cwd())`
    2. Store resolved ntfy config and scope as instance fields
    3. Update ntfy detail in `renderPlatforms`: show topic + priority + scope label when configured, "Not configured" when scope is "none"
    4. Update toggle logic: ntfy enabled state comes from resolved ntfy config, not from `config.ntfy`

- completed: Task 5 — Update configure-notify skill documentation
  - Description: Update `packages/notify/skills/configure-notify/SKILL.md` to document project-level ntfy config, the new `ntfy.json` file locations, scope semantics, and the updated wizard flow.
  - Dependencies: Tasks 1-4
  - Acceptance Criteria: Skill doc documents global and project ntfy.json locations, resolution order, scope selection in wizard, and updated settings overlay display.
  - Steps:
    1. Add "Project-Level ntfy Config" section after the ntfy platform section
    2. Document ntfy.json file locations (global and project)
    3. Document resolution order (project → global → disabled)
    4. Document scope selection in wizard
    5. Update config.json structure example to note ntfy section is legacy (migrated to ntfy.json)
    6. Update commands table if any commands changed

- completed: Task 6 — Build and verify
  - Description: Run TypeScript compilation to verify zero errors. Review all changed files for correctness.
  - Dependencies: Tasks 1-5
  - Acceptance Criteria: `tsc --noEmit --skipLibCheck` passes with zero errors. All files are consistent and cross-reference correctly.
  - Steps:
    1. Run `tsc --noEmit --skipLibCheck` from repo root
    2. Fix any type errors
    3. Review all changed files for import correctness
    4. Verify no circular dependencies between ntfy-config.ts and settings.ts

## Sequencing

```
Task 1 (ntfy-config.ts)  ──┐
                            ├──→ Task 3 (wizard scope) ──┐
Task 2 (cwd threading)  ──┤                               ├──→ Task 5 (docs) ──→ Task 6 (build)
                            ├──→ Task 4 (overlay scope) ──┘
                            │
```

Tasks 1 and 2 can be done in parallel (no code dependency). Tasks 3 and 4 depend on Task 1. Task 5 depends on Tasks 1-4. Task 6 is final verification.

## Risks

- **Config.json backward compatibility:** Old code running after migration still reads config.json ntfy section → no breakage. Both config.json ntfy and ntfy.json can coexist safely.
- **cwd at session_start:** `process.cwd()` captured once at session start. If user changes cwd mid-session, project config won't follow. This matches how MCP and subagents handle it — acceptable tradeoff.
- **ntfy.json vs config.json ntfy section:** After migration, both sources exist. Resolution must always prefer ntfy.json. The `migrateFromLegacyConfig` function only writes ntfy.json if it doesn't exist yet, so it won't overwrite user changes.
