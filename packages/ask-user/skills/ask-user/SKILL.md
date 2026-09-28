---
name: ask-user
description: >
  Ask the user multiple-choice questions with the ask_user tool (1–4 questions
  in one dialog, an "Other" free-text choice always included). Use when a
  decision, preference or clarification needs the user before you continue.
allowed-tools:
  - ask_user
---

# Ask User

`ask_user` shows one dialog with 1–4 questions and waits for the answers. If the tool call says it's turned off, ask in your reply — don't retry it.

## When to ask

- A choice with lasting impact (architecture, data model, naming, destructive steps)
- Requirements that are ambiguous or conflict
- A preference only the user can state

Ordinary engineering detail is not a reason to ask — decide and verify.

## How to ask

- **One call, every question you need now.** Never several `ask_user` calls at once.
- Each question: a full `question`, a short `header` (≤16 chars, shown as a chip), 2–4 `options` with a `label` (1–5 words) and a `description` (what it means or costs).
- Don't add an "Other" option — one is added automatically (`other: false` removes it when free text makes no sense).
- `multi_select: true` when several answers can apply.

```ts
ask_user({
  questions: [
    {
      header: "Database",
      question: "Which database should the service use?",
      options: [
        { label: "Postgres", description: "JSON columns, full-text search, one more service to run" },
        { label: "SQLite", description: "Zero setup; single writer" },
      ],
    },
    {
      header: "Features",
      question: "Which features ship in v1?",
      multi_select: true,
      options: [
        { label: "Search", description: "Full-text over notes" },
        { label: "Sharing", description: "Read-only links" },
        { label: "Export", description: "Markdown and JSON" },
      ],
    },
  ],
})
```

## What comes back

```
User answered your questions:
{
  "Which database should the service use?": { "selected": ["Postgres"], "skipped": false },
  "Which features ship in v1?": { "selected": ["Search"], "custom_text": "and tags", "skipped": false }
}
```

- `custom_text` is what the user typed under "Other". It may reference attached files as `[Image #N]` (the image follows in the result) or `[File #N: /path]`.
- `skipped: true` — the user chose not to answer. Respect it; don't ask again unless you must.
- "Not ready to answer" — the user wants to talk first. Ask what they want to clarify; don't re-send the same questions.
- Cancelled — the user stopped the turn. Wait for their next message.

## Workflow handoffs

An option can carry `action: "end_turn"` (picking it stops the turn) or `action: "new_session"` with a `prefill` (a message or `/command`). Picking a `new_session` option opens a launcher: **Compact & run** or **Run directly**.

```ts
ask_user({
  questions: [{
    header: "Next step",
    question: "What would you like to do next?",
    options: [
      { label: "Implement the plan", description: "Start work in a fresh session", action: "new_session", prefill: "/unipi:work specs:2026-09-28-auth-plan" },
      { label: "Done for now", description: "Return later", action: "end_turn" },
    ],
    other: false,
  }],
})
```

## Without a UI

In non-interactive runs, or when the tool is turned off, `ask_user` returns a notice instead of a dialog — ask in your reply. Inside a subagent it fails: put the question, the options and your recommendation in your report for the lead.
