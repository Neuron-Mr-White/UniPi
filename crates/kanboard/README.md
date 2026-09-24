# @pi-unipi/kanboard — core crate (v3)

The Rust half of kanboard v3: **one writer implementation** for every board
change. The CLI works standalone; K2 adds `serve` (daemon + UI + SSE) on top of
the same library.

Spec: [`docs/specs/2026-09-24-kanboard-v3-design.md`](../../docs/specs/2026-09-24-kanboard-v3-design.md).

```
crates/kanboard/
  build.rs            fails the build if web/dist/index.html is missing
  web/                the SolidJS UI (built separately with npm; web/dist is embedded)
  src/lib.rs          library (the daemon reuses this)
  src/main.rs         the `unipi-kanboard` binary (clap → library)
  src/format.rs       task file format: strict parser (line numbers) + renderer
  src/model.rs        statuses, priorities, actors, run blocks, staleness
  src/transitions.rs  the transition table (actors, required comments, finals)
  src/deps.rs         dependency DAG: cycles, readiness under a chain gate
  src/order.rs        sparse lane ordering + rebalancing
  src/store.rs        ~/.unipi/kanboard layout, project registry, flock, atomic writes
  src/board.rs        read/write every task file in a project
  src/commands.rs     the operations behind every subcommand
  src/run.rs          CLI dispatcher (JSON + human rendering)
  src/daemon.rs       daemon.json, the single-instance lock, `status`, `stop`
  src/serve/mod.rs    `serve`: axum router, listener, file watcher, idle shutdown, signals
  src/serve/api.rs    JSON API (every handler calls the library the CLI uses)
  src/serve/events.rs SSE `/events?project=<slug>`
  src/serve/assets.rs embedded web/dist (rust-embed) + SPA fallback
```

## Daemon (`serve`)

```bash
unipi-kanboard serve [--port N] [--idle-min N]   # 0 = OS-assigned port; idle default 10
unipi-kanboard status                            # daemon.json + liveness
unipi-kanboard stop [--timeout SECS]             # SIGTERM, waits ≤3s by default
```

- **Single instance:** `flock(daemon.lock)`. A second `serve` prints the running
  `daemon.json` as JSON and exits `0` (the pi extension relies on that).
- Binds `127.0.0.1` (`--port 0` → OS picks), writes `daemon.json`
  `{pid, port, version, startedAt}` atomically, and removes it on exit —
  including SIGTERM/SIGINT and idle shutdown.
- **Idle shutdown** after `--idle-min` (default 10) with no SSE clients and no
  HTTP requests in that window (`--idle-secs` is a hidden test knob).
- **File watcher** (`notify`) on `projects/`: content changes bump that project's
  revision and every `/events?project=<slug>` client gets `data: <rev>`. Access
  events are ignored (a read must not wake the UI) and bursts are coalesced, so
  one CLI write is exactly one revision.
- A pid whose process is gone (or a **zombie**) counts as dead, so `stop` and the
  stale-run check never hang on a corpse.

## JSON API

Every handler calls the same library functions as the CLI, so the UI cannot drift
from the terminal rules. The actor is always `user` (the UI never claims work).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ok, version, pid}` |
| GET | `/api/projects` | project summaries + per-lane counts |
| GET | `/api/projects/{slug}/tasks` | `?status=` `?ready=true` |
| GET | `/api/tasks/{slug}/{id}` | one task (deps status, staleness, ready) |
| POST | `/api/tasks/{slug}/create` | `{title, body?, status?, priority?, after?}` |
| POST | `/api/tasks/{slug}/{id}/move` | `{status, comment?}` — **409 + `needsComment`** when the rule needs one |
| GET | `/api/rules` | transition table for the `user` actor — `allowedMoves`, `commentRequired`, `final` |
| POST | `/api/tasks/{slug}/{id}/note` · `/edit` · `/link` · `/unlink` · `/order` · `/duplicate` | |

Rule violations answer 4xx with the message the CLI prints
(`{"ok":false,"error":"in_review → todo requires --comment (rework note)","kind":"rule"}`),
404 for unknown project/task, 400 for usage.

## UI

The UI is a SolidJS app under `web/`, built separately (`npm --prefix crates/kanboard/web
run build`) and embedded into the binary from `web/dist` with `rust-embed` — no
runtime filesystem dependency. `GET /` and any unmatched path serve `index.html`
(client-side routing owns everything past `/`); hashed asset paths are served
directly. `build.rs` fails the build with a clear message if `web/dist/index.html`
is missing.

## Storage

`UNIPI_KANBOARD_HOME` overrides the root (tests use it); otherwise
`~/.unipi/kanboard`.

```
projects/<slug>/
  project.json      {slug, name, root, prefix, nextId, createdAt}
  board.lock        flock held for every write in this project
  tasks/<PREFIX>-<n>.md
```

`slug` = `<basename(root)>-<first 6 hex of sha256(abs root)>`; the root is the
git toplevel (else cwd). `prefix` defaults to the first three alphanumerics of
the name, uppercased (`unipi` → `UNI`), and is editable with `project add --prefix`.

Every write is atomic (temp file in the same directory → `fsync` → `rename`)
and happens while holding `board.lock`, so several terminals can run `work`
against one board without double claims.

## Task file

```markdown
---
id: UNI-12
title: Add --verbose flag to loop.sh
status: todo            # backlog|todo|in_progress|in_review|blocked|done|cancelled|archived
priority: none          # none|low|medium|high|urgent
order: 3000             # sparse sort key inside a lane
deps: [UNI-10]
labels: []
created: 2026-09-24T10:00:00Z
updated: 2026-09-24T10:05:00Z
run:                    # present only while claimed
  session: 01a0ceb8
  pid: 12345
  host: coffee
  mode: direct          # direct|plan|goal
  goal: null
  started: 2026-09-24T10:05:00Z
---
Free-form description (markdown).

## Activity
- 2026-09-24T10:05:00Z [system] claimed by session 01a0ceb8 (mode direct)
- 2026-09-24T10:20:00Z [agent] blocked: which log format do you want?
  (continuation lines are indented)
```

`## Activity` is append-only. Anything else is a validation problem with a line
number: `validate` prints `<file>:<line>: <message>` and exits 1;
`validate --fix` rewrites canonical formatting (never semantic problems).

## CLI

```
project add [--root P] [--name N] [--prefix P] | project list | project show
add <title> [--body -|TEXT] [--status backlog|todo] [--priority ..] [--after ID...]
list [--status S] [--ready]      show <ID>
move <ID> <status> [--comment TEXT]
note <ID> <TEXT>                 edit <ID> [--title] [--body -] [--priority] [--labels]
link <ID> --after <DEP>          unlink <ID> --after <DEP>
order <ID> (--before ID | --after-pos ID | --top | --bottom)
claim-next --session S --pid P --host H [--mode M]        (system)
release <ID> --to todo|in_review|blocked --comment TEXT   (system)
set-run <ID> --mode M [--goal G]                          (system)
duplicate <ID>    archive-sweep [--after-days N]    validate [--fix]
serve | status | stop                                     (K2)
```

Global: `--project <slug>` (else `UNIPI_KANBOARD_PROJECT`, else the project
registered for the cwd's git root), `--actor user|agent|system` (else
`UNIPI_KANBOARD_ACTOR`, else `user`), `--gate in_review|done` (readiness gate for
`list --ready` and `claim-next`), `--json`.

Exit codes: `0` ok (including `claim-next` finding nothing), `1` rule violation /
validation finding, `2` usage error.

### `--json` payloads

| Command | Payload |
|---|---|
| `add`, `show`, `move`, `note`, `edit`, `link`, `unlink`, `order`, `release`, `set-run`, `duplicate` | the task object |
| `list`, `project list` | array of task / project objects |
| `claim-next` | `{"task": <task|null>, "waiting": [{"id", "waitingFor"}]}` |
| `archive-sweep` | `{"archived": [id], "skipped"?: reason}` |
| `validate` | `{"ok", "problems": [{"file","line","message","fixable"}], "fixed": [id]}` |
| `project show` | `{"project", "counts", "total"}` |

Errors are JSON on stderr: `{"ok": false, "kind": "rule|usage|not_found|io", "error": "…"}`,
and the message always names the violated rule, e.g.

```
in_review → todo requires --comment (rework note)
todo → in_progress is system only — claim it with `claim-next`
done is final — nothing moves out of it; use `duplicate` to create a new task instead
```

Task objects carry computed fields the UI/runner need: `ready`, `waitingFor`,
`depsStatus`, `staleness` (`running|stale|unknown`), `path`.

## Transitions

Only these moves exist; anything else is refused with the reason.

| From → To | Who | Requirement |
|---|---|---|
| backlog ↔ todo | user, agent | — |
| todo → in_progress | system | ready deps, unclaimed (`claim-next`) |
| in_progress → in_review | system | `--comment` (run summary) |
| in_progress → blocked | agent, system | `--comment` (what is needed) |
| in_progress → todo / backlog (stale run) | user, system | `--comment`; user needs a confirmed stale pid |
| in_review → done | user | — |
| in_review → todo / backlog | user | `--comment` (rework note) |
| blocked → todo | user | `--comment` (the answer, shown on next claim) |
| backlog / todo / blocked → cancelled | user | — |
| done / cancelled → archived | user | or automatically after `archiveAfterDays` |

`done`, `cancelled` and `archived` are final. Actors are an honour system: the
messages say so, and the skill forbids agents from passing `--actor user`.

## Readiness

A task is ready when it is `todo`, unclaimed, and every dep reached the chain
gate — `in_review` → `{in_review, done}` (default), `done` → `{done}`. Cancelled
and missing deps block. Ready tasks are taken by priority desc, then order asc.

## Tests

```bash
cargo test                 # 78 tests: format, transitions, deps, board, CLI
cargo clippy --all-targets -- -D warnings
```
