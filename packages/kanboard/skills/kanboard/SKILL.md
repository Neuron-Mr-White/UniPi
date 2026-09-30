---
name: kanboard
description: "Kanboard — the project's deferred-work board. Use when the user asks to note a task for later, to see what is on the board, or to work board tasks (e.g. do UNI-5): `start` a task before working on it and `finish` it with a summary when done; while working a board task: read it with `unipi-kanboard show`, add notes, block with a question, or file follow-up work."
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
<binary> --actor agent --project <slug> next                     # what would be picked next + why (read-only)
<binary> --actor agent --project <slug> chain <ID>               # upstream deps + downstream dependents
<binary> --actor agent --project <slug> search "<text>" [--all]  # id/title/body, archived excluded unless --all
<binary> --actor agent --project <slug> add "<title>" [--status todo] [--after <ID>] [--body-file <f>] [--attach <file>]…
<binary> --actor agent --project <slug> note <ID> "<text>"
<binary> --actor agent --project <slug> attach <ID> <file> --note "<what it shows>"
<binary> --actor agent --project <slug> attachments <ID>
<binary> --actor agent --project <slug> edit <ID> --title|--body|--labels …   # only tasks you created, while in backlog/todo
<binary> --actor agent --project <slug> start <ID>                          # todo → in progress, claimed for your session (costs a -do slot)
<binary> --actor agent --project <slug> finish <ID> --comment "<summary>"   # in progress → in review, only a task you started (free)
<binary> --actor agent --project <slug> move <ID> blocked --comment "<what you need>"
<binary> --actor agent --project <slug> link <ID> --after <DEP>
<binary> --actor agent --project <slug> unlink <ID> --after <DEP>
<binary> --actor agent --project <slug> order <ID> --top|--bottom|--before <ID>
```

There is **no queue and no runner** — the session works tasks itself
(`/unipi:kanboard-autowork` just keeps offering the next ready task).
`queue`, `unqueue`, `claim-next`, `set-run` and `edit --strategy/--plan` are
removed and refused.

`--json` gives machine-readable output for every subcommand (task objects carry
`ready`, `waitingFor`, `depsStatus` and `staleness`).

`list`/`search` show a one-line body excerpt; read a task's full description with
`show <ID>` before editing or starting it.

`settings show` reads the pi runtime and effective limits; `settings set`
and `rotate-token` are user-only — the agent is refused.

## Lanes and who may move what

| Move | Who |
|---|---|
| backlog ↔ todo | user, agent |
| todo → in progress | the agent with `start <ID>` (claims it for its session; costs a `-do` slot) |
| edit a task | agent — only tasks it created, and only in backlog/todo |
| in progress → in review | the agent with `finish <ID> --comment` — only a task its own session `start`ed |
| in progress → blocked | agent, system — **comment required** (what you need) |
| in progress → todo | user or system `release` — comment required (the session died or gave the task up) |
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
2. **Work the tasks yourself, in this session** (the user says "do UNI-5"):
   **`start` a task before working on it, `finish` it with a summary when done**
   — `start <ID>` before your first edit, `finish <ID> --comment "<what you
   did>"` before your turn ends (or `move <ID> blocked --comment "<what you
   need>"` if you cannot). `finish` and own-claim `blocked`/`note` are always
   free; **`start` costs one of your `-do` task slots** — count the tasks a
   request needs BEFORE starting anything, and if that is more than your
   remaining slots, start none of them: say what you can do now and ask whether
   to raise `kanboard.doTasks` or work in batches. In Review means "the agent
   did the work, a human reviews" — never leave a task you started In Progress
   (the board monitor will nudge you back to it). **Never move a task to
   `done`.**
3. **Never cancel.** If a task should be dropped, block it with
   `move <ID> blocked --comment "suggest cancel: <why>"` and let the user decide.
4. **Follow the blocking rule in your task prompt**: by default work
   autonomously and record assumptions with `note <ID> "assumed: <what/why>"`;
   block (with a comment saying exactly what you need) only when you truly
   cannot continue — `move <ID> blocked --comment "<what you need>"`.
5. **Work only on the task you were given.** Follow-up work goes to the board as
   a new task in Backlog (`add "<title>"`), optionally `link <new> --after <ID>`.
   A session holds one claim at a time, and at most `maxSessions` (default 2)
   sessions may run tasks in a project — if the board refuses a claim, that is
   why. You may
   block only the task your own session is running (`move <ID> blocked` checks
   `--session`/`UNIPI_KANBOARD_SESSION` against the claim).
6. **Sidekicks and subagents can read the board but never write it** — every
   write is refused with "board writes are the lead's job". Brief them with the
   task, then update the board yourself from their reports. (The lead session
   works tasks itself; `/unipi:kanboard-autowork` just keeps offering the next
   ready task in the same session — there is no separate worker.)
7. Use `note <ID> "<text>"` for progress worth remembering (decisions, what you
   verified, what you left undone) — it is the activity log the next reader sees.
8. Dependencies form a DAG: a task is ready only when every dep reached the chain
   gate (`in_review` by default, `done` when configured). Cancelled deps block
   forever, so unlink or re-plan instead of waiting. `chain <ID>` shows the
   whole line, `next` shows what would be picked and why others wait.

## Terminal-only execution

The web UI can create, edit, reorder, link and move tasks, but it **never runs a
task** — there is no run button. Work starts only from a terminal: the session
itself, driven by `/unipi:kanboard-do` (a task-slot + write budget for one
request) or `/unipi:kanboard-autowork` (the monitor keeps offering the next
ready task in this session — no separate worker exists). (The Done column's
"Summarize & archive" does call the agent command set in the board's Settings,
but only to write a summary.)

## Attachments

Users attach screenshots, logs and documents in the board UI; they appear in the
text as markdown with `att:<ID>/<name>` references, and `show <ID> --json` lists
them under `attachments` with an absolute `path` — read the file from there
(use your image-reading tool for images). To hand back evidence, `attach` a file:
it is stored beside the board and the comment embeds it, so the user sees the
image or file inline.
