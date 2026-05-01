# @pi-unipi/input-shortcuts

Keyboard shortcuts for Pi's input box — stash/restore, undo/redo, clipboard operations, thinking toggle, and tab insertion. All accessible via a vim-style chord overlay triggered by `ALT+S`.

## Features

| Chord | Action | Description |
|-------|--------|-------------|
| `ALT+S → S` | Stash/Restore | Save input text to stash register, or restore it |
| `ALT+S → U` | Undo | Pop from undo buffer (1s throttle) |
| `ALT+S → R` | Redo | Push current text forward, restore previous |
| `ALT+S → Y` | Copy | Copy input to system clipboard |
| `ALT+S → D` | Cut | Copy to clipboard, then clear input |
| `ALT+S → T` | Toggle Thinking | Cycle: off → low → medium → high → xhigh → off |
| `ALT+S → A → [0-9]` | Append Register | Append from numbered register 0-9 |
| `ALT+S → A → S` | Append Stash | Append from stash register |
| `ALT+I` | Tab Insert | Insert literal tab character into input |

## How It Works

### Chord Overlay

Press `ALT+S` to open a small overlay showing available actions with key hints. Press a single key within the overlay to execute the action. The overlay auto-closes after 300ms of inactivity or on `ESC`.

For the **Append** sub-chord, pressing `A` transitions to a second overlay showing numbered registers `[0-9]` and the stash register `[S]`.

### Registers

- **Stash register**: 1 register for quick save/restore of input text
- **Numbered registers**: 10 registers (0-9) for appending stored text snippets
- **Persistence**: All registers saved to `.unipi/config/input-shortcuts.json` (per-project, atomic writes)

### Undo/Redo

- In-memory ring buffer, max 50 snapshots per session
- **500ms debounce** on snapshot creation (prevents noise from rapid typing)
- **1s throttle** on undo (prevents rapid-fire undo)
- Redo buffer cleared on new snapshot (standard undo/redo semantics)
- Not persisted across sessions

### Clipboard

Cross-platform clipboard detection with automatic fallback:

| Platform | Read | Write |
|----------|------|-------|
| Linux (X11) | `xclip -selection clipboard -o` | `xclip -selection clipboard` |
| Linux (alt) | `xsel --clipboard --output` | `xsel --clipboard --input` |
| macOS | `pbpaste` | `pbcopy` |
| Windows | `powershell Get-Clipboard` | `clip` / `powershell Set-Clipboard` |

Detected tool is cached after first use. Returns graceful error if no clipboard tool is available.

### Thinking Toggle

Cycles through Pi's thinking levels in order:

```
off → low → medium → high → xhigh → off
```

## Settings

Run `/unipi:stash-settings` to open a TUI overlay for customizing keybindings:

- **Chord trigger key** — default `alt+s`
- **Tab insert key** — default `alt+i`

Both cycle through available ALT key combinations, excluding known conflicts (`alt+e` = cursorWordRight).

Config persisted to `~/.unipi/config/input-shortcuts-config.json` (global).

## Architecture

```
input-shortcuts/
├── index.ts              # Re-exports
├── src/
│   ├── index.ts          # Extension entry — registers shortcuts + command
│   ├── types.ts          # Shared types and constants
│   ├── registers.ts      # RegisterStore — JSON persistence with atomic writes
│   ├── undo-redo.ts      # UndoRedoBuffer — ring buffer with debounce/throttle
│   ├── clipboard.ts      # Cross-platform clipboard detection + read/write
│   ├── status.ts         # Status bar feedback with auto-clear
│   ├── chord-overlay.ts  # ChordOverlay — TUI overlay component (root + register sub-chord)
│   └── settings-overlay.ts # SettingsOverlay — SettingsList-based config UI
├── tests/
│   ├── clipboard.test.ts
│   ├── registers.test.ts
│   └── undo-redo.test.ts
└── package.json
```

### Key Patterns

- **TUI overlay**: Uses `ctx.ui.custom()` from pi-coding-agent (proven pattern from btw, compactor, footer)
- **SettingsList**: Uses `SettingsList` from pi-tui for the settings overlay
- **Atomic writes**: All file persistence uses write-to-tmp-then-rename pattern
- **Status feedback**: Every action shows a brief success/error message in the status bar via `ctx.ui.setStatus()`

## Testing

```bash
npm test --workspace=packages/input-shortcuts
```

19 tests across 3 suites:
- **clipboard** (4 tests): detection fallback, copy/paste roundtrip, graceful errors
- **RegisterStore** (8 tests): load/create, read/write stash/registers, corruption handling, atomic writes
- **UndoRedoBuffer** (7 tests): undo/redo roundtrip, debounce, throttle, max size eviction, clear

## Dependencies

- `@pi-unipi/core` — shared constants and utilities
- `@mariozechner/pi-coding-agent` — ExtensionAPI, ExtensionContext
- `@mariozechner/pi-tui` — Key, Container, Text, SettingsList, Focusable
