# BTW

Ask a side question while the main agent works, without adding it to the main conversation.

`@pi-unipi/btw` · part of [UniPi](../../README.md)

## What it does

- Opens a panel in place of the input box. The main agent continues to run.
- Answers each question in a new, read-only session. This session starts with a copy of the main conversation, with tool calls that are in progress.
- Gives the side session four tools only: `read`, `grep`, `find` and `ls`. It cannot run commands or change files.
- Uses the model and the thinking level of the main session.
- Writes nothing to the main session. The main agent never sees the question or the answer.
- Keeps no memory between questions. Each question starts again from the main conversation.

## Quick start

UniPi installs this package:

```bash
pi install npm:@pi-unipi/unipi
```

To install this package alone:

```bash
pi install npm:@pi-unipi/btw
```

Then ask a question:

```text
/unipi:btw what does the retry loop in client.ts do?
```

## Commands

| Command | What it does |
|---|---|
| `/unipi:btw [question]` | Opens the panel. If you give a question, the panel starts to answer it. |

In print mode (no UI), `/unipi:btw <question>` shows the answer as a notification. A question is necessary in this mode.

## Panel keys

| Key | What it does |
|---|---|
| `Enter` | Asks the question in the input. It does nothing while an answer streams. |
| `↑` / `↓` | Shows an earlier or later question and answer. Works when the input is empty. |
| `PgUp` / `PgDn` | Scrolls a long answer. |
| `Ctrl+C` | Stops the answer that streams. If no answer streams, it closes the panel. |
| `Esc` | Closes the panel. An answer that streams continues and goes into the history. |

Run `/unipi:btw` again to open the history. Only one answer can stream at a time.

## How it works

The panel shows each question, a line for each tool call, and the answer as markdown. The history stays in memory for the Pi session only. BTW clears it when a session starts or resumes, and when you move in the session tree.

If you want a change to your files, ask in the main conversation.

Older sessions can contain `btw-note` messages from an earlier BTW version. BTW still shows these messages and hides them from the model.

BTW comes from [pi-btw](https://github.com/Neuron-Mr-White/pi-btw) by Dan Bachelder.

## See also

- [Ask User](../ask-user/README.md)
- [Commands reference](../../docs/reference/commands.md)
