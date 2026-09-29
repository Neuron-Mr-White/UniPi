# Kanboard: agent start/finish + progress reminders — spec

Status: approved 2026-09-29 · owner: kanboard

## Problem

When an agent works board tasks by hand (the user says "do UNI-5 and UNI-8"),
the tasks stay in Todo: the board makes `todo → in_progress` and
`in_progress → in_review` system-only (runner). The agent has no command to
mark a task started or finished.

User decisions:
- A task being worked must be **In Progress** while it is worked.
- **In Review means "the agent did the work, a human reviews"** — the agent
  must move it there itself; the user must never have to.
- No LLM monitor (no jev, no third model). Reminders never block.

## Flow

```
 USER: "do UNI-5 and UNI-8"
   │
   ▼
 kanboard extension tracks per session (no LLM):
   mentioned = IDs in user prompts + IDs the agent `show`ed
   started   = IDs this session `start`ed (still in_progress)
   │
 AGENT TURN
   ├─ read / grep / show ─────────────────────────── no check
   ├─ first file-changing call this turn (edit / write / non-read bash)
   │     mentioned ∩ Todo ≠ ∅ AND started = ∅ ?
   │       yes ─► R1 steer, once per turn, appended to that tool result:
   │              "UNI-5, UNI-8 are still Todo. `start <ID>` the one you're on."
   ├─ unipi-kanboard start UNI-5            (free: no write credit)
   │     board: todo → in_progress, actor agent, claim = this session,
   │            deps satisfied, not already claimed. Visible immediately.
   ├─ … work …
   ├─ unipi-kanboard finish UNI-5 --comment "summary"   (free)
   │     board: in_progress → in_review, actor agent,
   │            only if claimed by THIS session; summary required
   ▼
 agent_end
   └─ a task in `started` still in_progress?
        yes ─► R2 follow-up message (max 2 per task):
               "UNI-8 is still In Progress. If done: `finish UNI-8 --comment …`.
                If not: say what remains, or `move UNI-8 blocked --comment …`."

 session dies mid-task ─► existing stale-claim reaper releases to Todo
 runner-owned runs (`queue`) ─► R1/R2 off; runner claims/finishes as today
 in_review → done | todo ─► user only (unchanged)
```

## Transition table after the change

```
todo        → in_progress   system (runner claim)  + agent (start, self-claim)   new
in_progress → in_review     system (run end)       + agent (finish, own claim)   new
in_progress → blocked       agent, system          unchanged
in_review   → done | todo   user only              unchanged
```

## Details

- `start`/`finish` cost 0 write credits and are allowed without an open
  `/unipi:kanboard-do` window (they only touch tasks the session claims).
- A session may have several tasks started. Runner-claimed tasks are never
  finishable by `finish` (different claim).
- Reminders: text-only, anti-poisoning suffix, never repeated beyond the caps,
  silent in runner runs and when no Todo task was mentioned.
- kanboard-do / kanboard skill text: "`start` a task before working on it,
  `finish` it with a summary when done."
- Setting `kanboard.reminders` (default true).

## Tests

- Rust: transition rows; start claims for the session; finish refuses another
  session's / runner's claim; summary required; credits untouched.
- TS: scripted tool sequences → R1 fires once, correct IDs; silent after
  start; silent in runner runs; R2 on agent_end, max 2 per task.
- Live (coffee): "do UNI-a and UNI-b" on a scratch board, reminders off vs on.
  Success: `start` before the first edit and `finish` before turn end in ≥ 9/10.
