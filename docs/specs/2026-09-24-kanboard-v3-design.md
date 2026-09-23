# Kanboard v3 — design

Status: agreed with the user 2026-09-24. Replaces the old htmx/Alpine kanboard entirely.

## Purpose
A per-project board for deferred work: jot notes/tasks now, let an agent do them later.
Clear tasks can be worked autonomously from a terminal (`/unipi:kanboard work`).

## Principles
1. **Terminal-only execution.** The web UI can create / edit / reorder / link / move tasks,
   but it never starts an agent. Work starts only from a pi terminal.
2. **The runner owns lifecycle transitions, not the agent.** Claim → In Progress and
   run-end → In Review are written by the pi extension from events. The agent only writes
   content (notes, blocked reason, new tasks).
3. **One writer implementation.** Every write goes through the Rust binary (CLI or daemon),
   which validates format + transition rules and writes atomically under a lock.
   Nobody (agent included) edits task files by hand.
4. **Prefix-cache safe.** No tools are added mid-session. The agent uses the CLI via bash,
   taught by the `kanboard` skill (a normal skill — hidden until jev skill-judging or a
   `/unipi:kanboard …` command reveals it).

## Components
- `crates/kanboard` — one Rust binary `unipi-kanboard` (clap + axum):
  - CLI subcommands (work without the daemon).
  - `serve` — the daemon (UI + SSE + file watch).
- `packages/kanboard` — pi extension (TS): commands, runner, settings, skill, binary resolution.
- Distribution: `@pi-unipi/kanboard` + `optionalDependencies` on
  `@pi-unipi/kanboard-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,win32-x64}`
  (esbuild/biome pattern). Binary lookup: `UNIPI_KANBOARD_BIN` env → platform package →
  dev fallback `crates/kanboard/target/{release,debug}`. Unsupported platform → the
  extension reports "kanboard unavailable on <platform>" and does nothing else.

## Storage — `~/.unipi/kanboard/`
```
daemon.json            {pid, port, version, startedAt}   (written by serve)
daemon.lock            flock held by the running daemon (single instance)
projects/<slug>/
  project.json         {slug, name, root, prefix, nextId, createdAt}
  board.lock           flock for every write in this project
  tasks/<PREFIX>-<n>.md
```
- `slug` = `<basename(root)>-<first 6 hex of sha256(abs root)>`; root = git toplevel, else cwd.
- `prefix` = up to 3 uppercase letters from the name (editable), e.g. `UNI-12`.

### Task file
```markdown
---
id: UNI-12
title: Add --verbose flag to loop.sh
status: todo            # backlog|todo|in_progress|in_review|blocked|done|cancelled|archived
priority: none          # none|low|medium|high|urgent
order: 3000             # sort key within a lane (sparse ints, rebalanced when needed)
deps: [UNI-10]          # must reach the chain gate before this is claimable
labels: []
created: 2026-09-24T10:00:00Z
updated: 2026-09-24T10:05:00Z
run:                    # present only while claimed
  session: 01a0ceb8
  pid: 12345
  host: coffee
  mode: direct          # direct|plan|goal
  goal: null            # long-horizon goal id when mode=goal
  started: 2026-09-24T10:05:00Z
---
Free-form description / acceptance criteria (markdown).

## Activity
- 2026-09-24T10:05:00Z [system] claimed by session 01a0ceb8 (mode direct)
- 2026-09-24T10:20:00Z [agent] blocked: which log format do you want?
```
- `## Activity` is append-only, one line per entry: `- <iso> [user|agent|system] <text>`
  (multi-line text is indented continuation lines).
- The binary rejects/normalises anything else (`validate` reports problems with line numbers).

## Lanes & transitions (enforced in the binary)
Lanes: Backlog, Todo, In Progress, In Review, Blocked, Done, Cancelled, Archive (hidden).
Actors: `user` (UI / human CLI), `agent` (CLI inside pi; env `UNIPI_KANBOARD_ACTOR=agent`),
`system` (the runner).

| From → To | Who | Requirement |
|---|---|---|
| backlog ↔ todo | user, agent | — |
| todo → in_progress | system only (claim) | deps satisfied, not claimed |
| in_progress (running) → * | system only; user may only cancel via the terminal that runs it | — |
| in_progress (stale: pid dead / other host unknown → user confirms) → todo/backlog/blocked | user, system | note added |
| in_progress → in_review | system (run end) | summary note |
| in_progress → blocked | agent, system | **comment required** (what is needed) |
| blocked → todo | user | **comment required** (the answer; shown to the agent on next claim) |
| in_review → done | user | — |
| in_review → todo/backlog | user | **comment required** (rework note) |
| backlog/todo/blocked → cancelled | user only | — |
| done/cancelled → archived | user (or auto after `archiveAfterDays`) | — |
| done/cancelled/archived → anything else | nobody | final — "Duplicate as new task" instead |

Agents can create tasks (into backlog/todo), add notes, link deps, move backlog↔todo, and
move their running task to Blocked. Agents cannot cancel or mark Done; to suggest
cancelling they block with "suggest cancel: <why>".
(The actor is an honour system — the agent could pass `--actor user`; the skill forbids it.)

## Dependencies / chains
- `deps` form a DAG (cycles rejected on `link`).
- **Chain gate** setting `kanboard.chainGate`: `in_review` (default) or `done`. A task is
  *ready* when status=todo, unclaimed, and every dep's status ∈ gate set
  (`in_review` → {in_review, done}; `done` → {done}). Cancelled deps block readiness.
- Independent chains run in parallel by running `work` in several terminals; `claim-next`
  is atomic under `board.lock`, so no double claims.
- Ready tasks are taken by (priority desc, order asc).

## CLI (`unipi-kanboard`, all support `--json`)
```
project add [--root P] [--name N] [--prefix P] | project list | project show
add <title> [--body -|TEXT] [--status backlog|todo] [--priority ..] [--after ID...]
list [--status S] [--ready]      show <ID>
move <ID> <status> [--comment TEXT]
note <ID> <TEXT>                  edit <ID> [--title] [--body -] [--priority] [--labels]
link <ID> --after <DEP>          unlink <ID> --after <DEP>
order <ID> (--before ID | --after-pos ID | --top | --bottom)
claim-next --session S --pid P --host H [--mode M]   (system)
release <ID> --to todo|in_review|blocked --comment TEXT      (system)
set-run <ID> --mode M [--goal G]                               (system)
duplicate <ID>    archive-sweep    validate [--fix]
serve [--port N] [--idle-min N]   status   stop
```
Global: `--project <slug>` or resolved from cwd (git root → slug); `--actor`
(default from `UNIPI_KANBOARD_ACTOR`, else `user`).

## Daemon (`serve`)
- Single instance: `flock(daemon.lock)`; if held, print the existing `daemon.json` and exit 0.
- Binds `127.0.0.1` on the configured port or an OS-assigned free port; writes `daemon.json`.
- Serves the UI + JSON API (same rules as the CLI — shared library code) + SSE stream fed by
  a file watcher on `projects/` (so CLI/agent writes appear live).
- Idle shutdown after `idleMin` (default 10) with no SSE clients; removes `daemon.json`.
- The pi extension starts it detached on demand (`/unipi:kanboard` / `open`), reuses it if
  `daemon.json` pid is alive and `GET /api/health` answers, and replaces it if stale.

## UI
- Project picker (all registered projects) → board with the 7 visible lanes (Archive
  behind a toggle).
- Cards: id, title, priority, dep badges (blocked-by count / chain), running indicator
  (session + mode). Detail drawer: body (markdown), activity log, comment box, deps editor.
- Drag to reorder within a lane / move between lanes; disallowed moves are refused with
  the rule's reason; moves that need a comment open a comment prompt.
- No "run" button anywhere.
- Frontend: **Topcoat** (tokio-rs, server-rendered Rust, no client build) if the spike
  passes; otherwise SolidJS built at release time and embedded via `rust-embed`.

## pi extension
Commands (`/unipi:kanboard <sub>` with arg completions):
- *(none)* / `open` — ensure daemon, print URL.
- `onboard` — register the current project (`project add`), reveal the kanboard skill
  (appended message, cache-safe), short explanation.
- `add <text>` — quick capture into Backlog, no agent turn.
- `work` — start the runner. `stop` — finish the current task then stop (Esc on the
  current turn aborts it → task released to todo with note "interrupted").
- `status` — daemon pid/port/uptime + project counts + this session's running task.

Runner (`work`), one job per session:
1. `claim-next` (session id, pid, host). None ready → report and stop.
2. jev picks the mode: `direct` | `plan` | `goal` (choice question with the task text;
   jev null → `direct`). `set-run` records it.
3. Sends the task to the agent as a user message: title, body, activity (incl. the unblock
   / rework comments), deps' outcomes, and the rules ("if you need information, run
   `unipi-kanboard move <ID> blocked --comment …` and stop").
   - plan → enters plan mode first; plan approval stays interactive.
   - goal → starts a long-horizon goal with the task as the objective; records the goal id.
4. On run end (direct: `agent_end` of that turn; plan: implementation turn settled;
   goal: goal completed/abandoned event): re-read the task. If the agent already moved it to
   blocked → respect. Else → `release --to in_review` with a summary note (last assistant
   message excerpt, ≤500 chars). Crash/abort → `release --to todo` with the reason.
5. Report in the terminal ("UNI-12 → In Review: …") then, if `kanboard.continue` (default
   true), claim the next task.
Env for the agent's bash: `UNIPI_KANBOARD_ACTOR=agent`, `UNIPI_KANBOARD_PROJECT=<slug>`,
binary dir on PATH.

## Settings (hub section "Kanboard")
`chainGate` in_review|done (in_review) · `continue` bool (true) · `idleMin` number (10) ·
`port` number (0 = auto) · `archiveAfterDays` number (0 = off) · action "Open board" ·
action "Stop daemon".

## Out of scope (v1)
UI → terminal dispatch; multi-user; remote hosts; custom lanes.

## Phases
- **K1** Rust crate: format, parser/validator, transitions, locking, CLI, tests. Topcoat spike.
- **K2** `serve` + UI + SSE + idle shutdown.
- **K3** pi extension: commands, runner, skill, settings, onboarding; delete old kanboard.
- **K4** Packaging (platform packages, CI matrix, release script), live test on coffee.
