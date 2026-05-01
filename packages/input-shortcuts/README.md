# @pi-unipi/input-shortcuts

Keyboard shortcuts for Pi's input box. Stash and restore text, undo/redo, clipboard operations, thinking level toggle, and tab insertion — all via a vim-style chord overlay triggered by `ALT+S`.

Press `ALT+S`, a small overlay appears with key hints. Press a key, the action runs. The overlay closes automatically after 300ms or on `ESC`.

## Shortcuts

| Chord | Action | Description |
|-------|--------|-------------|
| `ALT+S → S` | Stash/Restore | Save input to stash register, or restore it |
| `ALT+S → U` | Undo | Pop from undo buffer |
| `ALT+S → R` | Redo | Push current text forward, restore previous |
| `ALT+S → Y` | Copy | Copy input to system clipboard |
| `ALT+S → D` | Cut | Copy to clipboard, then clear input |
| `ALT+S → T` | Toggle Thinking | Cycle: off → low → medium → high → xhigh → off |
| `ALT+S → A → [0-9]` | Append Register | Append from numbered register 0-9 |
| `ALT+S → A → S` | Append Stash | Append from stash register |
| `ALT+I` | Tab Insert | Insert literal tab character |

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:stash-settings` | Open settings TUI for keybinding customization |

## Special Triggers

Input-shortcuts is a standalone package. It doesn't register with other packages or trigger coexists behavior.

Every action shows a brief success or error message in the status bar via `ctx.ui.setStatus()`.

## How It Works

### Registers

- **Stash register**: 1 register for quick save/restore
- **Numbered registers**: 10 registers (0-9) for stored text snippets
- **Persistence**: Saved to `.unipi/config/input-shortcuts.json` (per-project, atomic writes)

### Undo/Redo

- In-memory ring buffer, max 50 snapshots per session
- 500ms debounce on snapshot creation (prevents noise from rapid typing)
- 1s throttle on undo (prevents rapid-fire undo)
- Redo buffer cleared on new snapshot
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

Cycles through Pi's thinking levels: off → low → medium → high → xhigh → off.

## Configurables

Run `/unipi:stash-settings` to customize keybindings:

- **Chord trigger key** — default `alt+s`
- **Tab insert key** — default `alt+i`

Both cycle through available ALT key combinations, excluding known conflicts (`alt+e` = cursorWordRight).

Config persisted to `~/.unipi/config/input-shortcuts-config.json` (global).

## License

MIT
