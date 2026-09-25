---
name: kanboard
description: "Kanboard — the project's deferred-work board. Use when the user asks to note a task for later, to see what is on the board, or while working a board task: read it with `unipi-kanboard show`, add notes, block with a question, or file follow-up work."
---

# Kanboard

The board is a per-project list of deferred work: backlog, todo, in progress, in
review, blocked, done, cancelled (and an archive). **The board files are owned by
the `unipi-kanboard` binary** — never edit `task.md` files by hand; every write
goes through the CLI so the format and the transition rules hold.

## The CLI

Always pass the actor and the project, and call it by absolute path (it may not
be on `PATH`):

```sh
<binary> --actor agent --project <slug> list [--ready] [--json]
<binary> --actor agent --project <slug> show <ID>
<binary> --actor agent --project <slug> next                     # what claim-next would pick + why
<binary> --actor agent --project <slug> chain <ID>               # upstream deps + downstream dependents
<binary> --actor agent --project <slug> search "<text>" [--all]  # id/title/body, archived excluded unless --all
<binary> --actor agent --project <slug> add "<title>" [--status todo] [--after <ID>] [--body-file <f>] [--attach <file>]…
<binary> --actor agent --project <slug> note <ID> "<text>"
<binary> --actor agent --project <slug> attach <ID> <file> --note "<what it shows>"
<binary> --actor agent --project <slug> attachments <ID>
<binary> --actor agent --project <slug> edit <ID> --title|--body|--labels …   # only tasks you created, while in backlog/todo
<binary> --actor agent --project <slug> move <ID> blocked --comment "<what you need>"
<binary> --actor agent --project <slug> link <ID> --after <DEP>
<binary> --actor agent --project <slug> unlink <ID> --after <DEP>
<binary> --actor agent --project <slug> order <ID> --top|--bottom|--before <ID>
<binary> --actor agent --project <slug> queue <ID>… | queue --list            # your session's work queue (limit: setting queueMax, default 10)
<binary> --actor agent --project <slug> unqueue [<ID>…]                      # no ids clears it
```

`--json` gives machine-readable output for every subcommand (task objects carry
`ready`, `waitingFor`, `depsStatus` and `staleness`).

`settings show` reads the pi runtime and effective limits; `settings set`
and `rotate-token` are user-only — the agent is refused.

## Lanes and who may move what

| Move | Who |
|---|---|
| backlog ↔ todo | user, agent |
| todo → in progress | **the runner only** (`claim-next`) |
| edit a task | agent — only tasks it created, and only in backlog/todo |
| in progress → in review | **the runner only** (when your turn ends) |
| in progress → blocked | agent, system — **comment required** (what you need) |
| blocked → todo | user only — comment required (the answer) |
| in review → done | user only |
| in review → todo/backlog | user only — comment required (rework note) |
| anything → cancelled | user only |
| in review → archived | user only (one-click archive) |
| done/cancelled → archived | user (or automatically) |

`done`, `cancelled` and `archived` are final: nothing leaves them — file a new
task instead (the UI's "Duplicate" does that for you). Old archived/cancelled
tasks may be moved to cold storage (`projects/<slug>/cold/`); the board never
lists them — read the files there directly if you need one.

## Rules for agents

1. **Never pass `--actor user`.** That is an honour system: pretending to be the
   user to cancel a task or mark it done breaks the board's whole contract.
2. **Never move a task to `in_review` or `done`.** The runner writes those when
   your turn ends; claiming them yourself loses the summary and the review step.
3. **Never cancel.** If a task should be dropped, block it with
   `move <ID> blocked --comment "suggest cancel: <why>"` and let the user decide.
4. **To ask the user something, block the task and stop**: `move <ID> blocked
   --comment "<exactly what you need>"`. The answer arrives as a comment the next
   time the task is claimed.
5. **Work only on the task you were given.** Follow-up work goes to the board as
   a new task in Backlog (`add "<title>"`), optionally `link <new> --after <ID>`.
   A session holds one claim at a time, and at most `maxSessions` (default 2)
   sessions may run tasks in a project — if the board refuses a claim, that is
   why. You may
   block only the task your own session is running (`move <ID> blocked` checks
   `--session`/`UNIPI_KANBOARD_SESSION` against the claim).
6. **To have tasks worked during a `/unipi:kanboard-do` turn, queue them** with
   `queue <IDs>` (Todo tasks, up to the queue limit — setting `queueMax`, default 10) — the runner starts them one by one
   after the turn ends. Never claim or start them yourself.
7. Use `note <ID> "<text>"` for progress worth remembering (decisions, what you
   verified, what you left undone) — it is the activity log the next reader sees.
8. Dependencies form a DAG: a task is ready only when every dep reached the chain
   gate (`in_review` by default, `done` when configured). Cancelled deps block
   forever, so unlink or re-plan instead of waiting. `chain <ID>` shows the
   whole line, `next` shows what would be picked and why others wait.

## Terminal-only execution

The web UI can create, edit, reorder, link and move tasks, but it **never runs a
task** — there is no run button. Work starts only from a terminal with
`/unipi:kanboard-autowork start` (or the queue after a `/unipi:kanboard-do`). (The Done column's "Summarize & archive" does call the
agent command set in the board's Settings, but only to write a summary.)

## Attachments

Users attach screenshots, logs and documents in the board UI; they appear in the
text as markdown with `att:<ID>/<name>` references, and `show <ID> --json` lists
them under `attachments` with an absolute `path` — read the file from there
(use your image-reading tool for images). To hand back evidence, `attach` a file:
it is stored beside the board and the comment embeds it, so the user sees the
image or file inline.
