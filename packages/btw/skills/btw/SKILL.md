---
name: btw
description: Ask side questions in an inline panel without interrupting the main agent — read-only, one-shot, invisible to the main session.
---

# BTW

`/unipi:btw <question>` opens an inline panel and answers a side question from a fresh read-only session seeded with the main session's current context.

Rules the panel enforces:
- Read-only tools (`read`, `grep`, `find`, `ls`) — no commands or edits; changes belong in the main conversation.
- No memory between btw questions, and nothing reaches the main agent.
- Nothing is persisted — page history dies with the pi session.

When to suggest it: quick clarifications, "what is X doing" checks, reading files, thinking out loud — anything that shouldn't derail or pollute the main turn.
