# @pi-unipi/input-shortcuts

Keyboard shortcuts for Pi's input box. Stash and restore text, undo/redo, copy the last response, push the editor text to the kanboard backlog, and tab insertion — all via a vim-style chord overlay triggered by `ALT+S`.

Press `ALT+S`, a small overlay appears with key hints. Press a key, the action runs. The overlay closes automatically after selecting an action, on `ESC`, or on an unknown key.

## Shortcuts

| Chord | Action | Description |
|-------|--------|-------------|
| `ALT+S → S` | Stash/Restore | Save input to the stash register, or restore it |
| `ALT+S → U` | Undo | Step back through editor checkpoints |
| `ALT+S → R` | Redo | Step forward again (an edit invalidates the redo) |
| `ALT+S → A` | Append Stash | Append the stash text to the input (stash kept) |
| `ALT+S → Y` | Copy Last Response | Copy the last assistant response to the system clipboard |
| `ALT+S → K` | Add to Kanboard Backlog | Add the editor text to the project's kanboard backlog as a body-only task (attached file paths in the text are uploaded) |
| `ALT+I` | Tab Insert | Insert literal tab character |

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:settings` | Customize keybindings (Input Shortcuts group) |

## Special Triggers

Input-shortcuts is a standalone package. It doesn't register with other packages or trigger coexists behavior.

Every action shows a brief success or error message in the status bar via `ctx.ui.setStatus()`.

## How It Works

### Stash

- **Stash register**: 1 register for quick save/restore
- **Persistence**: Saved to `.unipi/config/input-shortcuts.json` (per-project, atomic writes). Files written by older versions (with ten numbered registers 0-9) still load; the register keys are ignored and dropped on the next save.

### Undo/Redo

- Linear checkpoint history, O(1) amortized per record
- A typing burst records the editor text exactly twice — before the first keystroke and after the last (burst closes after 600ms of quiet, and long bursts split every ~2s) — so undo works from the very first keystroke without reading the editor on every keypress
- At most 100 checkpoints / 2M characters in memory (oldest evicted first)
- An edit after an undo invalidates the redo; undoing captures un-flushed typing first
- Not persisted across sessions

### Copy Last Response

Uses pi's own cross-platform `copyToClipboard` (wl-copy / xclip / pbcopy / Windows / WSL / OSC 52 fallbacks) on the text of the last assistant response — the same text pi's `/copy` copies.

### Kanboard Backlog

The K chord hands the editor text to `globalThis.__unipi_kanboard_api.captureToBacklog()` (registered by `@pi-unipi/kanboard`): the text becomes a body-only Backlog task, and file paths in the text (pasted/dragged files and pasted images, which pi inserts as paths) are attached. Refuses with a status message when kanboard is not loaded or the folder is not onboarded.

## Configurables

Run `/unipi:settings` (Input Shortcuts group) to customize keybindings:

- **Chord trigger key** — default `alt+s`
- **Tab insert key** — default `alt+i`

Both cycle through available ALT key combinations, excluding known conflicts (`alt+e` = cursorWordRight).

Config persisted to `~/.unipi/config/input-shortcuts-config.json` (global).

## License

MIT
