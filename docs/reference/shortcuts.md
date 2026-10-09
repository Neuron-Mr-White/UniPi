# Keyboard shortcuts

This page lists the keys that UniPi adds to Pi. The list comes from the
`pi.registerShortcut` calls and the terminal input handlers in the source.
Pi has its own keys too. This page does not list them.

Terms such as plan mode and sidekick are in the [glossary](glossary.md).

## Keys in the main editor

These keys work while the Pi input box has focus.

| Key | Package | What it does |
|---|---|---|
| `Alt+P` | [workflow](../../packages/workflow/README.md) | Toggles plan mode. |
| `Alt+M` | [workflow](../../packages/workflow/README.md) | Cycles the permission mode: `ask`, `auto`, `full`. |
| `Alt+H` | [core](../../packages/core/README.md) | Shows the next Unicrab hint. |
| `Alt+Shift+H` | [core](../../packages/core/README.md) | Shows the previous hint. |
| `Alt+S` | [input-shortcuts](../../packages/input-shortcuts/README.md) | Opens the chord overlay. See [Chord keys](#chord-keys). |
| `Alt+I` | [input-shortcuts](../../packages/input-shortcuts/README.md) | Adds a tab character to the input. |
| `Shift+Down` | [background-tasks](../../packages/background-tasks/README.md) | Opens the work tray on the Background tasks tab. |
| `Ctrl+Alt+C` | [background-tasks](../../packages/background-tasks/README.md) | Clears the notices of finished background tasks. |
| `Ctrl+B` | [subagents](../../packages/subagents/README.md) | Moves the foreground subagents to the background. |
| `Down` | [core](../../packages/core/README.md) | Opens the work tray: one pane with a Background tasks tab and a Subagents tab. This works only when the input is empty and the session has background tasks or subagents. In the tray, `Left` and `Right` switch tabs and `Esc` closes it. |

The background-tasks keys exist only when the `background-tasks` setting
`enabled` is on.

### Keys that change Pi behavior

UniPi also watches some Pi keys. It does not stop the Pi action.

| Key | Package | What it does |
|---|---|---|
| `Ctrl+C` | [input-shortcuts](../../packages/input-shortcuts/README.md) | Pi clears the input. UniPi keeps the cleared text in the transcript as struck-through text. Push `Up` to get the text back. |
| `Backspace` | [utility](../../packages/utility/README.md) | When the input ends with an `[Image #N]` or `[File #N]` token, it deletes the full token. |
| Paste | [utility](../../packages/utility/README.md) | Pasted image or file paths become `[Image #N]` or `[File #N]` tokens. |

The paste and `Backspace` behavior needs the `utility` setting
`attachments.enabled`. This setting is on by default.

## Chord keys

Push `Alt+S` to open the chord overlay. Then push one key. The action runs and
the overlay closes.

| Key | What it does |
|---|---|
| `S` | Saves the input to the stash and clears the input. When the input is empty, it puts the stash back. |
| `U` | Undo. It goes back one editor checkpoint. |
| `R` | Redo. |
| `A` | Adds the stash text to the end of the input. The stash stays. |
| `Y` | Copies the last agent response to the clipboard. |
| `K` | Adds the input text to the kanboard backlog as a new task. |
| `Esc` | Closes the overlay. |

Any other key closes the overlay and does nothing.

The settings hub has the fields `chordKey` and `tabInsertKey`. In this release,
the code registers `Alt+S` and `Alt+I` directly. A changed value shows in the
info screen, but the keys stay `Alt+S` and `Alt+I`.

## Keys in the settings hub

These keys work in `/unipi:settings`.

| Key | What it does |
|---|---|
| `Up`, `Down`, `k`, `j` | Moves the cursor. |
| `PgUp`, `PgDn`, `Home`, `End` | Moves the cursor by a page, or to the first or last row. |
| `/` | Starts a search. |
| `Enter`, `Tab` | Opens, edits, picks or runs the row. |
| `Space` | Toggles a switch, or goes to the next value of a list. |
| `g` | Toggles the write scope between global and project. |
| `u` | Undoes the last change. |
| `d` | Sets the row back to its default. |
| `R` | Sets the row back to its value at the time the hub opened. |
| `Esc` | Goes back one page, clears the search, or closes the hub. |

In an order editor, `Shift+J`, `Shift+K`, `Alt+Up` and `Alt+Down` move the
selected item.

## Keys in other dialogs

| Dialog | Key | What it does |
|---|---|---|
| `/unipi:model` picker | `Alt+Enter` | Saves the selected row as the startup model. |
| `/unipi:model` picker | `Tab`, `Shift+Tab` | Moves the focus between lead, sidekick and effort. |
| `ask_user` dialog | `Tab`, `Shift+Tab`, `Left`, `Right` | Goes to the next or previous question. |
| `ask_user` dialog | `1` to `9` | Picks an option. |
| `ask_user` dialog | `Ctrl+V`, `Alt+V` | Attaches a clipboard image to the "Other" answer. |
| `ask_user` dialog | `Esc` | Stops the turn, or sends the answers. The `ask-user` setting `escape` selects which. |
| `/unipi:answer questions` | `Ctrl+G` | Opens the answers in your `$EDITOR`. |

In most UniPi lists, `j` and `k` move the cursor and `q` or `Esc` closes the
list.
