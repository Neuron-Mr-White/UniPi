# @pi-unipi/input-shortcuts

Keyboard shortcuts for Pi's input box — stash/restore, undo/redo, clipboard operations, and thinking toggle.

## Features

- **Stash/Restore** (`ALT+S → S`): Save input text to stash register, restore it later
- **Undo/Redo** (`ALT+S → U/R`): Navigate text history with 50-entry ring buffer
- **Clipboard** (`ALT+S → Y/D`): Copy/cut input to system clipboard
- **Register Append** (`ALT+S → A → [0-9/S]`): Append from numbered registers or stash
- **Thinking Toggle** (`ALT+S → T`): Cycle thinking levels
- **Tab Insert** (`ALT+I`): Insert literal tab character

## Usage

Press `ALT+S` to open the chord overlay, then press a single key to execute an action. The overlay auto-closes after 300ms of inactivity.

## Settings

Run `/unipi:stash-settings` to customize keybindings via a TUI overlay.

## Architecture

Chord-based overlay system using Pi's `ctx.ui.custom()` API. Register storage persisted to `.unipi/config/input-shortcuts.json`. Undo/redo buffer is in-memory only (not persisted across sessions).
