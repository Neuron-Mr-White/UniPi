---
title: "Input Shortcuts — Implementation Plan"
type: plan
date: 2026-05-01
workbranch: feat/input-shortcuts
specs:
  - .unipi/docs/specs/2026-05-01-input-shortcuts-design.md
---

# Input Shortcuts — Implementation Plan

## Overview

Implement an input shortcuts package that provides keyboard shortcuts for stash/restore, undo/redo, clipboard operations, and thinking toggle — all accessible via an overlay-based chord system triggered by `ALT+S`. Also includes a `/unipi:stash-settings` command with a TUI overlay for customizing shortcut keybindings.

### Key Design Change from Spec

The spec originally designed a **state machine chord handler** using `ctx.ui.onTerminalInput()` to capture raw keypresses. **This API does not exist** in the pi extension API. The revised approach uses a **TUI overlay** (proven pattern from btw, compactor, footer) that:

1. `ALT+S` opens a small overlay showing available actions with key hints
2. User presses a single key within the overlay → action executes → overlay closes
3. For sub-chord (`A → [0-9]`), the overlay transitions to a second state showing register options

This preserves the vim-style chord UX using infrastructure that actually exists.

### ALT Key Conflict

`ALT+E` is already bound to `tui.editor.cursorWordRight`. The tab-insertion shortcut will use `ALT+I` instead (free, mnemonic: **I**nsert).

## Tasks

- unstarted: Task 1 — Create package skeleton
  - Description: Create `packages/input-shortcuts/` with package.json, tsconfig, index.ts, src/ directory structure following the footer/compactor pattern.
  - Dependencies: None
  - Acceptance Criteria: Package exists with correct structure, workspace registered, pi extension entry in root package.json
  - Steps:
    1. Create `packages/input-shortcuts/package.json` following footer pattern (name: `@pi-unipi/input-shortcuts`, peer deps on pi-coding-agent + pi-tui, dep on @pi-unipi/core)
    2. Create `packages/input-shortcuts/tsconfig.json` extending root
    3. Create `packages/input-shortcuts/src/` directory with placeholder files: types.ts, registers.ts, undo-redo.ts, clipboard.ts, status.ts, chord-overlay.ts, settings-overlay.ts, index.ts
    4. Create `packages/input-shortcuts/README.md` with usage docs
    5. Add `"@pi-unipi/input-shortcuts": "*"` to root package.json dependencies
    6. Add `"node_modules/@pi-unipi/input-shortcuts/src/index.ts"` to root package.json `pi.extensions` array

- unstarted: Task 2 — Implement types.ts
  - Description: Define shared type definitions for register data, undo/redo snapshots, config schema, and chord state.
  - Dependencies: Task 1
  - Acceptance Criteria: All types compile, used by downstream modules
  - Steps:
    1. Define `TextSnapshot { text: string; timestamp: number }`
    2. Define `RegisterData { stash: string; registers: string[] }`
    3. Define `InputShortcutsConfig` with customizable keybindings (default `alt+s` for chord, `alt+i` for tab)
    4. Define `ChordAction` enum/type: stash, redo, undo, appendRegister, appendStash, copy, cut, toggleThinking, tab
    5. Define `ChordState` type: idle | chord_root | chord_reg

- unstarted: Task 3 — Implement registers.ts
  - Description: Register store with JSON file persistence. 10 numbered registers (0-9) + 1 stash register (S). File: `.unipi/config/input-shortcuts.json`. Atomic writes (write to .tmp then rename).
  - Dependencies: Task 2
  - Acceptance Criteria: Can load, get/set stash, get/set registers, persist to disk. Unit tests pass.
  - Steps:
    1. Implement `RegisterStore` class with lazy load on first access
    2. Implement `getStash()`, `setStash(text)`, `getRegister(index)`, `setRegister(index, text)`
    3. Implement atomic file write (write to `.tmp`, rename)
    4. Create directory on first write if missing
    5. Write unit tests: load/create file, read/write stash, read/write registers, roundtrip

- unstarted: Task 4 — Implement undo-redo.ts
  - Description: In-memory ring buffer (max 50 snapshots) with debounce (500ms) and undo throttle (1s). Redo buffer cleared on new snapshot.
  - Dependencies: Task 2
  - Acceptance Criteria: Snapshot/undo/redo work correctly, throttle prevents rapid-fire, debounce prevents noise. Unit tests pass.
  - Steps:
    1. Implement `UndoRedoBuffer` class with undo stack + redo stack
    2. Implement `snapshot(text)` — push to undo stack, clear redo stack, 500ms debounce
    3. Implement `undo(currentText)` — pop undo, push current to redo, 1s throttle
    4. Implement `redo(currentText)` — pop redo, push current to undo
    5. Implement `clear()` for session shutdown
    6. Write unit tests: basic undo/redo, throttle, debounce, redo-clears-on-new-snapshot, max size eviction

- unstarted: Task 5 — Implement clipboard.ts
  - Description: Cross-platform clipboard read/write using child_process. Detection order: xclip → xsel → pbcopy/pbpaste → clip/powershell. Cache detected command.
  - Dependencies: None
  - Acceptance Criteria: Detects available clipboard tool, copies and pastes text. Returns error gracefully if unavailable. Unit tests pass.
  - Steps:
    1. Implement `detectClipboard()` — try each platform command, cache result
    2. Implement `copyToClipboard(text)` — write text via detected command
    3. Implement `pasteFromClipboard()` — read text via detected command
    4. Handle errors gracefully (return `{ ok: false, reason: "clipboard unavailable" }`)
    5. Write unit tests: detection fallback, copy/paste roundtrip (skip in CI if no clipboard)

- unstarted: Task 6 — Implement status.ts
  - Description: Status bar feedback helper using `ctx.ui.setStatus("input-shortcuts", text)` with auto-clear after duration.
  - Dependencies: None
  - Acceptance Criteria: Shows status text, auto-clears after specified duration
  - Steps:
    1. Implement `showStatus(ctx, text, durationMs)` — set status, setTimeout to clear
    2. Implement constants: `STATUS_SUCCESS_MS = 2000`, `STATUS_ERROR_MS = 3000`

- unstarted: Task 7 — Implement chord-overlay.ts
  - Description: TUI overlay component that opens on `ALT+S`, shows action menu, captures keypresses. Uses `ctx.ui.custom()` pattern from btw/compactor. Two states: root chord and register sub-chord.
  - Dependencies: Task 2, Task 3, Task 4, Task 5, Task 6
  - Acceptance Criteria: Overlay renders action list, keypress triggers action, 300ms timeout auto-closes, register sub-chord works. Actions execute correctly.
  - Steps:
    1. Implement `ChordOverlay` class with `render(width)` and `handleInput(data)`
    2. Root state shows action table: `[S] Stash/Restore  [R] Redo  [U] Undo  [A] Append  [Y] Copy  [D] Cut  [T] Thinking`
    3. On keypress: match to action, execute, close overlay
    4. On `A`: transition to register sub-chord, show register list `[0-9] Register N  [S] Stash`
    5. 300ms timeout: auto-close overlay, clear status
    6. Implement all actions:
       - Stash: if input non-empty → snapshot, save to stash, clear input. If empty → restore stash.
       - Redo: pop redo buffer, set editor text
       - Undo: pop undo buffer (1s throttle), set editor text
       - Append register: read register N, append to current input
       - Append stash: read stash, append to current input
       - Copy: copy input to clipboard via clipboard.ts
       - Cut: copy input to clipboard, snapshot, clear input
       - Toggle thinking: cycle off→low→medium→high→xhigh→off
    7. Show status feedback after each action (via status.ts)

- unstarted: Task 8 — Implement settings-overlay.ts and /unipi:stash-settings command
  - Description: Settings TUI overlay (using SettingsList from pi-tui, following compactor pattern) that lets users customize the chord trigger keybinding and the tab-insert keybinding. Persist config to `.unipi/config/input-shortcuts-config.json`. Register `/unipi:stash-settings` command.
  - Dependencies: Task 2, Task 7
  - Acceptance Criteria: `/unipi:stash-settings` opens overlay, user can change keybindings, settings persist and are used by the chord handler
  - Steps:
    1. Define config schema: `{ chordKey: string, tabInsertKey: string }` with defaults `alt+s` and `alt+i`
    2. Implement `loadConfig()` / `saveConfig()` with atomic writes to `.unipi/config/input-shortcuts-config.json`
    3. Implement `SettingsOverlay` using SettingsList from pi-tui (compactor pattern)
    4. Settings items: Chord trigger key, Tab insert key — values cycle through free ALT key options
    5. Register `/unipi:stash-settings` command that opens the overlay
    6. On config save, re-register shortcuts with new keybindings (if possible) or inform user to restart

- unstarted: Task 9 — Implement index.ts — extension entry point
  - Description: Wire everything together. Register `ALT+S` shortcut (or configured key) that opens chord overlay. Register `ALT+I` shortcut for tab insertion. Register `/unipi:stash-settings` command. Handle session lifecycle.
  - Dependencies: Task 3, Task 4, Task 5, Task 6, Task 7, Task 8
  - Acceptance Criteria: Extension loads, shortcuts register, chord overlay opens on ALT+S, tab insert works on ALT+I, settings command works, cleanup on session shutdown
  - Steps:
    1. Import all modules, create shared instances (RegisterStore, UndoRedoBuffer)
    2. Load config on init (lazy)
    3. Register chord shortcut (default `alt+s`) via `pi.registerShortcut()` — handler opens chord overlay
    4. Register tab insert shortcut (default `alt+i`) — handler appends `\t` to editor text
    5. Register `/unipi:stash-settings` command — handler opens settings overlay
    6. On `session_shutdown`: cancel chord, clear undo buffer

- unstarted: Task 10 — Integration testing and manual verification
  - Description: Test all shortcut actions end-to-end in Pi TUI. Verify overlay renders correctly, actions work, settings persist.
  - Dependencies: Task 9
  - Acceptance Criteria: All 8 actions work from the chord overlay, settings overlay opens and saves, tab insert works
  - Steps:
    1. Build and verify no type errors: `npm run typecheck`
    2. Run unit tests: `npm test --workspace=packages/input-shortcuts`
    3. Manual test: ALT+S opens overlay, each key (S/R/U/A/Y/D/T) executes correctly
    4. Manual test: A→[0-9] register append works, A→S stash append works
    5. Manual test: ALT+I inserts tab
    6. Manual test: /unipi:stash-settings opens settings, change keybinding, verify it works
    7. Verify status bar feedback appears and auto-clears

## Sequencing

```
Task 1 (skeleton)
  ├── Task 2 (types)
  │     ├── Task 3 (registers)
  │     ├── Task 4 (undo-redo)
  │     └── Task 5 (clipboard)
  │           └── Task 6 (status)
  │                 └── Task 7 (chord overlay) ← depends on 3,4,5,6
  │                       ├── Task 8 (settings overlay)
  │                       │     └── Task 9 (index.ts wiring)
  │                       │           └── Task 10 (integration test)
```

Tasks 3, 4, 5, 6 can be developed in parallel after Task 2.
Task 7 is the critical path — the core overlay component.
Task 8 adds the settings UI on top.
Task 9 wires everything together.

## Risks

1. **`Key.alt("s")` format** — The spec uses `Key.alt("s")` from pi-tui, but `registerShortcut()` in the docs shows string format `"alt+s"`. Need to verify which format works. The btw extension uses `Key.alt("/")` which suggests the Key object approach works.

2. **Overlay `handleInput` receiving raw keys** — The overlay's `handleInput(data)` receives raw terminal escape sequences. Need to match against single characters for chord keys. If user presses a modifier key combo, it may send multi-byte sequences that don't match.

3. **Shortcut re-registration** — If the user changes keybindings in settings, we may not be able to unregister the old shortcut. May need to require a restart for keybinding changes to take effect.

4. **Config file path** — Spec says `.unipi/config/` (per-project). For keybindings, global (`~/.unipi/config/`) might be better since users likely want the same shortcuts across projects. Will use global config path for keybindings, per-project for register storage.

5. **`ALT+S` conflict check** — `alt+s` is NOT in the built-in keybindings list, so it's free. Verified.
