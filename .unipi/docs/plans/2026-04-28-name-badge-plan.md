---
title: "Name Badge Overlay — Implementation Plan"
type: plan
date: 2026-04-28
workbranch: ""
specs:
  - .unipi/docs/specs/2026-04-28-name-badge-design.md
---

# Name Badge Overlay — Implementation Plan

## Overview

Add a persistent HUD-style overlay showing the current session name in the top-right corner of the terminal. Includes toggle visibility (`/unipi:name-badge`), LLM-powered name generation (`/unipi:badge-gen`), and auto-restore on session restart. ~150 lines of new code in the `@pi-unipi/utility` package.

## Tasks

- completed: Task 1 — Add command constants to core
  - Description: Add `NAME_BADGE` and `BADGE_GEN` entries to `UTILITY_COMMANDS` in `packages/core/constants.ts`
  - Dependencies: None
  - Acceptance Criteria: Constants compile, importable from `@pi-unipi/core`
  - Steps:
    1. Open `packages/core/constants.ts`
    2. Add `NAME_BADGE: "name-badge"` and `BADGE_GEN: "badge-gen"` to the `UTILITY_COMMANDS` object
    3. Verify no TypeScript errors

- completed: Task 2 — Create NameBadgeComponent
  - Description: Create `packages/utility/src/tui/name-badge.ts` — a pure render `Component` that displays a single-line bordered badge with the session name
  - Dependencies: None
  - Acceptance Criteria: Component renders correctly, truncates with ellipsis when name exceeds width, uses theme colors for accent/muted/border
  - Steps:
    1. Create `packages/utility/src/tui/name-badge.ts`
    2. Import `Component` from `@mariozechner/pi-tui` and `Theme` from `@mariozechner/pi-coding-agent`
    3. Implement `NameBadgeComponent` class:
       - Constructor takes `name: string | null`
       - `render(width: number): string[]` — returns 1 line with bordered box
       - `setName(name: string | null)` — updates text, calls `invalidate()`
       - `setTheme(theme: Theme)` — stores theme reference
       - `invalidate()` — clears cached render lines
       - No `handleInput` — display-only component
    4. Render format: `┌─ {name} ─┐` with theme.fg("accent", name) or theme.fg("muted", "Set a name now") for placeholder
    5. Truncate name with ellipsis if `visibleWidth(badge) > width`
    6. Export the class

- completed: Task 3 — Create NameBadgeState
  - Description: Create `packages/utility/src/tui/name-badge-state.ts` — state manager handling overlay lifecycle, polling, toggle, restore, and LLM name generation
  - Dependencies: Task 1, Task 2
  - Acceptance Criteria: State manager correctly toggles overlay visibility, polls for name changes every 1s, persists state via `pi.appendEntry()`, restores on session start, sends hidden LLM prompt for name generation
  - Steps:
    1. Create `packages/utility/src/tui/name-badge-state.ts`
    2. Import types: `ExtensionAPI`, `ExtensionCommandContext` from pi, `Component` from pi-tui
    3. Implement `NameBadgeState` class:
       - State: `visible`, `currentName`, `overlayHandle`, `pollTimer`, `component`
       - `toggle(pi, ctx)` — toggle visibility, persist state
       - `show(pi, ctx)` — open overlay via `ctx.ui.custom()` with `overlay: true`, `anchor: "top-right"`, `offsetX: -1`, `offsetY: 1`, `minWidth: 20`, `visible: (w) => w >= 40`. Wire `overlay.requestRender = () => tui.requestRender()`
       - `hide()` — close overlay handle, stop polling
       - `startPolling(pi)` — `setInterval` every 1s, check `pi.getSessionName()`, update component if changed
       - `stopPolling()` — `clearInterval`
       - `restore(pi, ctx)` — on `session_start`, check persisted state, call `show()` if visible
       - `generate(pi, ctx)` — enable badge if hidden, send hidden message via `pi.sendMessage()` with `display: false` and `triggerTurn: true`, set 30s timeout for name detection
    4. Persistence: `pi.appendEntry("name-badge", { visible: boolean })` on toggle
    5. Export the class

- completed: Task 4 — Register commands
  - Description: Update `packages/utility/src/commands.ts` to register `/unipi:name-badge` and `/unipi:badge-gen`
  - Dependencies: Task 1, Task 3
  - Acceptance Criteria: Both commands appear in `/unipi:*` autocomplete, `/unipi:name-badge` toggles badge, `/unipi:badge-gen` generates name via LLM
  - Steps:
    1. Open `packages/utility/src/commands.ts`
    2. Import `NameBadgeState` from `./tui/name-badge-state.js`
    3. Add `registerNameBadgeCommands(pi: ExtensionAPI, state: NameBadgeState)` function
    4. Register `/unipi:name-badge`:
       - Handler: call `state.toggle(pi, ctx)`, notify "Name badge enabled/disabled"
       - Check `ctx.hasUI` — warn if no UI
    5. Register `/unipi:badge-gen`:
       - Handler: call `state.generate(pi, ctx)`, notify "Generating session name..."
       - Check `ctx.hasUI` — warn if no UI
    6. Export the function
    7. Add new commands to `ALL_COMMANDS` array in index.ts

- completed: Task 5 — Wire lifecycle events in index.ts
  - Description: Update `packages/utility/src/index.ts` to instantiate `NameBadgeState` and wire `session_start` / `session_shutdown` events
  - Dependencies: Task 3, Task 4
  - Acceptance Criteria: Badge state restores on session start, cleans up on session shutdown
  - Steps:
    1. Open `packages/utility/src/index.ts`
    2. Import `NameBadgeState` from `./tui/name-badge-state.js`
    3. In the extension factory function:
       - Create `const nameBadgeState = new NameBadgeState()`
       - Add `pi.on("session_start", ...)` handler: call `nameBadgeState.restore(pi, ctx)`
       - Add to existing `pi.on("session_shutdown", ...)` handler: call `nameBadgeState.hide()`
       - Call `registerNameBadgeCommands(pi, nameBadgeState)`
    4. Add `NAME_BADGE` and `BADGE_GEN` to `ALL_COMMANDS` array

- completed: Task 6 — Update README
  - Description: Add the two new commands to the utility package README Commands table
  - Dependencies: None
  - Acceptance Criteria: README lists both commands with descriptions
  - Steps:
    1. Open `packages/utility/README.md`
    2. Find the Commands table
    3. Add rows for `/unipi:name-badge` (Toggle name badge overlay) and `/unipi:badge-gen` (Generate session name via LLM)

## Sequencing

```
Task 1 (constants) ──┐
                     ├──→ Task 3 (state manager) ──→ Task 4 (commands) ──→ Task 5 (index.ts wiring)
Task 2 (component) ──┘                                                          │
                                                                                ↓
Task 6 (README) ────────────────────────────────────────────────────────────────┘
```

- Tasks 1, 2, 6 can start immediately (no dependencies between them)
- Task 3 depends on 1 + 2
- Task 4 depends on 1 + 3
- Task 5 depends on 3 + 4
- Task 6 is independent, can be done anytime

## Risks

- **`pi.getSessionName()` API availability** — if this method doesn't exist or returns unexpected values, polling will fail silently. Mitigation: wrap in try/catch, show placeholder on error.
- **`pi.appendEntry()` for persistence** — verify this API exists and supports custom entry types. If not, fall back to in-memory state only (badge won't persist across restarts).
- **`triggerTurn: true` with hidden message** — the LLM must have `set_session_name` as an available tool for badge-gen to work. If not available, the name generation will time out gracefully after 30s.
- **Overlay stacking** — badge stays in its layer when other overlays open. This is by design but may surprise users who expect the badge to always be on top.

---

## Reviewer Remarks

REVIEWER-REMARK: Done
- Task 1 ✅ — `NAME_BADGE` and `BADGE_GEN` constants added to `UTILITY_COMMANDS` in `packages/core/constants.ts`
- Task 2 ✅ — `NameBadgeComponent` in `packages/utility/src/tui/name-badge.ts` — renders bordered badge, truncates with ellipsis, uses theme accent/muted/border colors
- Task 3 ✅ — `NameBadgeState` in `packages/utility/src/tui/name-badge-state.ts` — toggle, show/hide, 1s polling, persistence via `pi.appendEntry()`, restore on session_start, LLM generate with 30s timeout
- Task 4 ✅ — Both commands registered in `packages/utility/src/commands.ts` with UI guard checks, added to `ALL_COMMANDS` in index.ts
- Task 5 ✅ — `session_start` calls `nameBadgeState.restore()`, `session_shutdown` calls `nameBadgeState.hide()`, wired in `packages/utility/src/index.ts`
- Task 6 ✅ — README updated with both commands in table and dedicated Name Badge usage section

Codebase Checks:
- ✓ TypeScript (tsc --noEmit): passed — zero errors
- ⚠ Biome lint: 8 errors (`noExplicitAny` — necessary due to pi-tui overlay API lacking exported types), 13 warnings (formatting tabs vs spaces — pre-existing codebase-wide convention; import organization — auto-fixable)
- ✓ Tests: 69/69 passed (no new tests for TUI component — depends on pi runtime)
- ✗ Build: no build script in utility package (not applicable)
- ✗ Docker: no Dockerfile (not applicable)
