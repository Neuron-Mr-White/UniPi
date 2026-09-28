# @pi-unipi/ask-user

The `ask_user` tool: when the agent needs a decision from you, it asks 1–4 multiple-choice questions in one dialog and waits. Modelled on Devin's question UI.

```
── Planet ✓ · Foods 2 · Last book ─────────────────────────────────────
  What was the last book you read?
    Can't remember
    Don't read books
  ❭ Other (type your own)
    └ Dune, cover: [Image #1]
      [Image #1] red-cube.png · 570 KB
───────────────────────────────────────────────────────────────────────
↑↓ navigate · ↵ select · ctrl+v image · ←→ switch question · esc cancel
? Not ready to answer, help me out!
```

## Answering

| Key | Action |
|-----|--------|
| `↑` `↓` | Move between options |
| `1`–`9` | Pick that option (single choice: picks and moves on; multi-select: toggles) |
| `space` | Toggle (multi-select) |
| `enter` | Select and go to the next question; on the last one, send everything |
| `←` `→`, `tab` | Switch question (in a non-empty "Other" they move the text cursor) |
| type | On "Other", just type — no Enter needed. The option numbers hide so digits are text |
| paste / drop / `ctrl+v` | In "Other": a pasted or dropped image/file path, or a clipboard image (Ctrl+V), becomes `[Image #N]` / `[File #N]`; images are sent to the model with your answer |
| `?` | Not ready to answer: the agent is told you want to clarify first |
| `esc` | Cancel and stop the agent's turn |

Questions you leave unanswered are sent as **skipped** — skipping never blocks. The header chips show progress: `✓` answered, a number for multi-select picks.

In the transcript the answers stay as a short tree (`● Asked user 3 questions` / `│ Planet: Mars` / `└ Last book: Dune`).

## For the agent

```ts
ask_user({
  questions: [{
    header: "Database",                       // ≤16 chars, shown as a chip
    question: "Which database should the service use?",
    options: [                                // 2–4; "Other" is added automatically
      { label: "Postgres", description: "JSON columns, full-text search" },
      { label: "SQLite", description: "Zero setup; single writer" },
    ],
    multi_select: false,                      // optional
    other: true,                              // optional; false removes "Other"
  }],
})
```

The result is `User answered your questions:` followed by a JSON object keyed by question: `{ "selected": [...], "custom_text": "...", "skipped": false }`. Attached images follow as image content.

- Tool calls from one message run one at a time, so several `ask_user` calls can never hide each other (they used to: only the last dialog was answerable and the turn hung).
- Options can carry `action: "end_turn"` or `action: "new_session"` with a `prefill` — the workflow skills use these for handoffs; a launcher offers **Compact & run** or **Run directly**.
- The older single-question form (`question`, `context`, `options`, `allowMultiple`, `allowFreeform`) is still accepted; `timeout` is ignored — you answer in your own time.
- Inside a subagent the tool fails with instructions to report the question to the lead instead.

## Settings

`/unipi:settings` → Ask User: turn the tool off, and whether a notification is sent when the agent asks.
