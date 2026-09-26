# @pi-unipi/btw

`/unipi:btw [question]` opens an inline panel over the input area for a quick side question — the main agent keeps running and never sees any of it.

Each question runs in a fresh read-only pi session seeded from the main session's current branch (including in-progress tool calls). There is **no memory between btw questions** — earlier Q&As are not fed back. Page history lives only for the pi session and is cleared on new/resume/tree navigation. Nothing is written to the main session.

## Panel

```
❭ <question>          your question
… / ✓ tool lines      read-only tools only (read, grep, find, ls)
Thinking..            while waiting
answer                rendered as markdown
❭ Ask a /btw…         input (locked while streaming)
```

- `Enter` ask · `↑`/`↓` (empty input) page earlier Q&As · `PgUp`/`PgDn` scroll long answers · `Ctrl+C` cancel the answer · `Esc` back to the chat (a streaming answer keeps running into history; reopen with `/unipi:btw`).

Read-only: `read`, `grep`, `find`, `ls` only — no commands, no file changes. If you want something changed, ask in the main conversation.

Without a UI (print mode), `/unipi:btw <question>` prints the answer via notify.

Based on [pi-btw](https://github.com/Neuron-Mr-White/pi-btw) by Dan Bachelder.
