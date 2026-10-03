# Ask User

Let the agent stop and ask you multiple-choice questions when it needs a decision.

`@pi-unipi/ask-user` · part of [UniPi](../../README.md)

## What it does

- Adds the `ask_user` tool. The tool is **off** by default.
- Shows 1 to 4 questions in one dialog. Each question has 2 to 4 options.
- Adds an "Other (type your own)" option, so you can type a free answer. You can paste or drop images and files into this answer.
- Sends a question that you do not answer as "skipped". A skipped question does not stop the dialog.
- Shows each answer in the transcript as a short tree.
- Can send a notification while it waits for you, through [Notify](../notify/README.md).

```text
── Planet ✓ · Foods 2 · Last book ─────────────────────────────────────
  What was the last book you read?
    Can't remember
    Don't read books
  ❭ Other (type your own)
    └ Dune, cover: [Image #1]
───────────────────────────────────────────────────────────────────────
↑↓ navigate · ↵ select · ctrl+v image · ←→ switch question · esc cancel
? Not ready to answer, help me out!
```

## Quick start

UniPi installs this package:

```bash
pi install npm:@pi-unipi/unipi
```

To install this package alone:

```bash
pi install npm:@pi-unipi/ask-user
```

To turn on the tool:

1. Open `/unipi:settings`.
2. Select the **Ask User** group.
3. Set **Enable ask_user** to on.

When the tool is off, it tells the agent to ask in its reply.

## Answer the questions

| Key | What it does |
|---|---|
| `↑` / `↓` | Moves between options. |
| `1`–`9` | Selects that option. In a multi-select question, it toggles the option. |
| `Space` | Toggles an option in a multi-select question. |
| `Enter` | Selects and goes to the next question. On the last question, it sends all answers. |
| `←` / `→`, `Tab`, `Shift+Tab` | Goes to another question. In an "Other" field with text, `←` and `→` move the cursor. |
| `Ctrl+V` | Pastes an image from the clipboard into the "Other" field. |
| `?` | Tells the agent that you are not ready to answer and want to talk first. |
| `Esc` | Stops the agent turn. A setting can make `Esc` send your answers. |

In the "Other" field, you type text directly. The option numbers disappear, so digits go into the text. A pasted image becomes `[Image #N]`, and a file path becomes `[File #N]`. The tool sends images to the model with your answers.

## Agent tools

| Tool | What it does |
|---|---|
| `ask_user` | Asks 1 to 4 questions in one dialog and waits for the answers. |

```ts
ask_user({
  questions: [{
    header: "Database",                       // 16 characters or fewer
    question: "Which database should the service use?",
    options: [                                // 2–4 options
      { label: "Postgres", description: "JSON columns, full-text search" },
      { label: "SQLite", description: "No setup, single writer" },
    ],
    multi_select: false,                      // optional
    other: true,                              // optional, false removes "Other"
  }],
})
```

The result starts with `User answered your questions:`. A JSON object follows, with one key for each question: `{ "selected": [...], "custom_text": "...", "skipped": false }`. Images follow as image content.

Other facts:

- An option can have `action: "end_turn"`. This option ends the turn.
- An option can have `action: "new_session"` and a `prefill` message. You then select **Compact & run** or **Run directly**. Workflow skills use this to start the next step.
- The tool runs one dialog at a time. Thus several calls in one message cannot hide each other.
- The tool also accepts the older single-question form: `question`, `context`, `options`, `allowMultiple`, `allowFreeform`. It ignores `timeout`.
- In a subagent, the tool fails. The error tells the subagent to give the question to its lead.
- With no interactive UI, the tool tells the agent to ask in its reply.

## Settings

Open `/unipi:settings` → **Ask User**. A change applies to the next question.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | Gives the agent the `ask_user` tool. |
| `notifyOnAsk` | `true` | Sends a notification while the agent waits. |
| `maxQuestions` | `4` | Maximum questions in one dialog (1–4). The tool description changes in new sessions. |
| `escape` | `stop` | `stop` ends the agent turn. `send` sends your answers and skips the rest. |
| `digitAdvance` | `true` | In a single-choice question, a number key also goes to the next question. |
| `other` | `agent` | `agent` lets the agent decide. `always` and `never` override the agent. |
| `helpLine` | `true` | Shows the "Not ready to answer" line. The `?` key works in all cases. |

## See also

- [Notify](../notify/README.md)
- [BTW](../btw/README.md)
- [Tools reference](../../docs/reference/tools.md)
