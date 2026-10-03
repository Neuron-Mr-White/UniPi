# Input Shortcuts

Input Shortcuts adds editor keys to stash text, undo edits, copy the last reply and capture a kanboard task.

`@pi-unipi/input-shortcuts` · part of [UniPi](../../README.md)

## What it does

- `Alt+S` opens a chord overlay. You press one more key to run an action.
- Stash keeps one piece of editor text, and the stash stays after a restart.
- Undo and redo step through editor text. History starts at the first keystroke.
- `Y` copies the last agent reply to the system clipboard.
- `K` adds the editor text to the kanboard backlog.
- After Ctrl+C clears the editor, the cleared text stays in the transcript, struck through. `↑` restores it.

## Quick start

Input Shortcuts ships in `@pi-unipi/unipi`. To install it alone:

```bash
pi install npm:@pi-unipi/input-shortcuts
```

1. Type some text in the editor.
2. Press `Alt+S`.
3. Press `S` to stash the text. The editor clears.
4. Press `Alt+S`, then `S` again to restore the text.

## Shortcuts

| Keys | What it does |
|---|---|
| `Alt+S`, then `S` | Stash or restore. With text in the editor, it saves the text and clears the editor. With an empty editor, it restores the stash. |
| `Alt+S`, then `A` | Adds the stash text to the end of the editor text. The stash stays. |
| `Alt+S`, then `U` | Undo. |
| `Alt+S`, then `R` | Redo. An edit after an undo clears the redo steps. |
| `Alt+S`, then `Y` | Copies the last agent reply to the clipboard. |
| `Alt+S`, then `K` | Adds the editor text to the kanboard backlog as a task. File paths in the text become attachments. |
| `Alt+I` | Adds a tab character to the end of the editor text. |
| `Esc` in the overlay | Closes the overlay. Any other key also closes it. |

Each action shows a short message in the status bar for 2 seconds. An error message stays for 3 seconds.

The `K` action needs [Kanboard](../kanboard/README.md) in the same session. If Kanboard is not loaded, the status bar shows `kanboard not loaded`.

## Settings

Open `/unipi:settings` → Input Shortcuts. The namespace is `input-shortcuts`. The project scope is the default.

| Key | Default | What it does |
|---|---|---|
| `chordKey` | `alt+s` | Stored chord key. The info screen shows it. |
| `tabInsertKey` | `alt+i` | Stored tab key. The info screen shows it. |

In this release, the shortcuts stay on `Alt+S` and `Alt+I`. The code does not read these two settings when it registers the keys.

## How it works

- **Stash.** The stash file is `.unipi/config/input-shortcuts.json` in the current folder. Input Shortcuts writes it to a temp file first, then renames it.
- **Undo history.** Input Shortcuts records the editor text two times for each typing burst: before the first key and after the last key. A burst ends after 600 ms with no keys, or after 2 seconds. The history keeps 100 states or 2,000,000 characters at most. The history does not stay after the session ends.
- **Copy.** `Y` uses the same clipboard function as pi `/copy`.
- **Ctrl+C.** Input Shortcuts does not change what Ctrl+C does. It only reads the key. The struck-through line is a UI entry, so the model never sees it.

## See also

- [Shortcuts reference](../../docs/reference/shortcuts.md)
- [Kanboard](../kanboard/README.md)
