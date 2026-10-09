# Kanboard crate

The Rust binary `unipi-kanboard` holds the Kanboard task files, the transition rules, the daemon and the web UI. It is the only program that writes board files.

**Web UI = the UniPi app's web build (UNI-117).** The daemon serves the UniPi app (`unipi-app/apps/mobile`, `npm run build:web`) at `/`: one frontend for phone, desktop and browser. The old Solid UI in `web/` is **deprecated**, and its only remaining use is as a fallback. Design, parity table and leftovers: `unipi-app/docs/m7/KANBOARD-MIGRATION.md`.

Crate `kanboard` · binary `unipi-kanboard` · used by [`@pi-unipi/kanboard`](../../packages/kanboard/README.md)

## Layout

```
crates/kanboard/
  build.rs              fills ui-dist/ via scripts/build-ui.mjs when it is missing
  scripts/build-ui.mjs  puts the web UI into ui-dist/ (embedded into the binary)
  ui.lock.json          pinned published UniPi web build (url + sha256)
  ui-dist/              the embedded UI (gitignored; .source.json says where it came from)
  web/                  DEPRECATED SolidJS UI, fallback only
  src/main.rs           the binary (clap → library)
  src/lib.rs            the library that the CLI and the daemon share
  src/cli.rs            clap definitions        src/run.rs    CLI dispatcher (JSON and text)
  src/model.rs          statuses, priorities, actors, run blocks, staleness
  src/format.rs         task file parser (with line numbers) and renderer
  src/transitions.rs    transition table       src/deps.rs   dependency graph, readiness
  src/order.rs          sparse lane order      src/board.rs  read and write the task files
  src/store.rs          home layout, project registry, locks, atomic writes
  src/attachments.rs    files attached to tasks
  src/commands.rs       the operation behind each subcommand
  src/daemon.rs         daemon.json, single-instance lock, status, stop
  src/serve/            daemon: router (mod.rs), api.rs, events.rs (SSE), auth.rs,
                        assets.rs, settings.rs, undo.rs
```

## Build and test

```bash
node crates/kanboard/scripts/build-ui.mjs       # writes ui-dist (build.rs does this if it is missing)
cargo build --release --manifest-path crates/kanboard/Cargo.toml
cargo test --manifest-path crates/kanboard/Cargo.toml
cargo clippy --all-targets --manifest-path crates/kanboard/Cargo.toml -- -D warnings
```

### Where the web UI comes from

`scripts/build-ui.mjs` uses the first source that works and records it in `ui-dist/.source.json`. `/api/health` reports it as `ui: {source, version}`.

1. `UNIPI_KANBOARD_UI_DIST=<dir>`: a web build that already exists (CI, packagers).
2. The UniPi app checkout nested at `unipi-app/` (gitignored here; override with `UNIPI_APP_DIR`). The script runs `npm ci` if needed, then `npm run build:web` in `apps/mobile`.
3. `ui.lock.json`: the published tarball on `https://unipi.nrn.one/releases/web/`, sha256-checked. `unipi-app/scripts/publish-web.sh` uploads it and prints the pin.
4. The deprecated `web/` UI. `cargo build` prints a warning.

Force a source with `--source env|app|pin|legacy`. Refresh after app changes with `node crates/kanboard/scripts/build-ui.mjs`. CI (`kanboard-binaries.yml`) checks out unipi-app when the `UNIPI_APP_TOKEN` secret exists. `ci.yml` embeds the legacy UI on purpose, because `tests/ui.mjs` drives that DOM. Script tests: `node --test crates/kanboard/tests/build-ui.test.mjs`.

The pi extension finds the binary in this order:

1. `UNIPI_KANBOARD_BIN`.
2. The npm package `@pi-unipi/kanboard-<platform>-<arch>`.
3. `crates/kanboard/target/{release,debug}/unipi-kanboard`.

`npm run publish:kanboard` publishes the five platform packages. It skips a package with an empty `bin/` folder.

## Storage

The root is `~/.unipi/kanboard/`. `UNIPI_KANBOARD_HOME` overrides it.

```
daemon.json  daemon.lock  token  settings.json
projects/<slug>/
  project.json          {slug, name, root, prefix, nextId, createdAt, archived}
  board.lock            flock, held for each write
  tasks/<PREFIX>-<n>.md
  attachments/<ID>/     attached files
  cold/                 archived and cancelled tasks after retentionDays
```

The slug is `<basename(root)>-<first 6 hex of sha256(root)>`. The root is the git top-level folder, or the current folder. The prefix is the first three letters or digits of the name, in upper case. Each write goes to a temporary file, then `fsync`, then `rename`, while the process holds `board.lock`.

A task file has YAML front matter (`id`, `title`, `status`, `priority`, `order`, `deps`, `labels`, `created`, `updated`, and `run` while claimed) and a markdown body. The `## Activity` section is append-only. `validate` prints `<file>:<line>: <message>` for each problem. `validate --fix` rewrites the format only.

## CLI

```
project add [--root P] [--name N] [--prefix P] | list | show | archive <slug> | unarchive <slug>
add [<title>] [--body TEXT|-] [--body-file F] [--attach F] [--status backlog|todo]
    [--priority none|low|medium|high|urgent] [--after ID] [--label L]
list [--status S] [--all] [--ready]   show <ID>   chain <ID>   search <text> [--all]
move <ID> <status> [--comment TEXT] [--attach F]
note <ID> <TEXT> [--attach F]   attach <ID> <FILE> [--note TEXT] [--name N]   attachments <ID>
edit <ID> [--title] [--body] [--priority] [--labels A,B]
link <ID> --after <DEP>   unlink <ID> --after <DEP>
order <ID> (--before ID | --after-pos ID | --top | --bottom)
next   start <ID> [--pid P]   finish <ID> --comment TEXT [--attach F]   release <ID> --to S --comment TEXT
reap [--dry-run]   duplicate <ID>   archive-sweep [--after-days N] [--retention-days N]
validate [--fix]   settings show | settings set <field> <value>   rotate-token
serve [--host A] [--port N] [--idle-min N] [--require-auth] [--keep-token]   status   stop [--timeout S]
```

Global flags: `--project` (else `UNIPI_KANBOARD_PROJECT`, else the project of the git root), `--actor user|agent|system` (else `UNIPI_KANBOARD_ACTOR`, else `user`), `--session` (else `UNIPI_KANBOARD_SESSION`), `--gate in_review|done` and `--json`.

Exit codes: `0` success, `1` rule or validation error, `2` usage error. With `--json`, errors go to stderr as `{"ok": false, "kind": "rule|usage|not_found|io", "error": "…"}`. The message names the rule, for example `in_review → todo requires --comment (rework note)`.

`settings set` and `rotate-token` refuse the `agent` actor. `UNIPI_KANBOARD_MAX_SESSIONS` (default 2) limits the sessions that can hold In Progress tasks in one project.

## Transitions

| From → To | Actor | Comment |
|---|---|---|
| backlog ↔ todo | user, agent | — |
| todo → in_progress | agent, system | — (`start`: deps ready, no claim, session limit) |
| in_progress → in_review | agent, system | run summary (`finish`, own claim only) |
| in_progress → blocked | agent, system | what the agent needs |
| in_progress → todo or backlog | user, system | the reason to release the stale run |
| in_review → done | user | — |
| in_review → todo or backlog | user | rework note |
| in_review → archived | user | — |
| blocked → todo | user | the answer for the agent |
| blocked → done | user | — |
| backlog, todo or blocked → cancelled | user | — |
| done or cancelled → archived | user, system | — |

`done`, `cancelled` and `archived` are final. A task is ready when it is `todo`, has no claim, and each dependency reached the gate (`in_review` gate: in_review or done. `done` gate: done). `next` sorts ready tasks by priority, then order, then ID.

## Daemon

`serve` starts the web UI, the JSON API and server-sent events (SSE).

- **One instance.** The daemon holds `flock(daemon.lock)`. A second `serve` prints `{"alreadyRunning": true, "bindingChanged": …, "daemon": …}` and exits with `0`.
- **daemon.json** holds `{pid, port, version, startedAt, host, token?}`. The daemon removes it on exit.
- **Idle stop.** The daemon stops after `--idle-min` minutes (default 10) with no HTTP request and no SSE client.
- **File watch.** A change under `projects/` increments the project revision. Each `GET /events?project=<slug>` client gets `data: <rev>`.
- **Access.** A loopback bind needs no token, unless you use `--require-auth`. Other binds need the token as `?t=`, the `kb_token` cookie or `Authorization: Bearer`. A POST with an `Origin` that differs from `Host` gets a refusal.

## JSON API

Each handler calls the library that the CLI uses. The API always acts as `user`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | `{ok, version}`, plus `pid` on loopback |
| GET | `/api/projects` · `/api/dashboard` · `/api/running` | Project summaries, dashboard data, claimed tasks |
| PUT | `/api/projects/{slug}` | `{archived}` |
| GET | `/api/projects/{slug}/tasks` | `?status=`, `?ready=true` |
| GET | `/api/tasks/{slug}/{id}` | One task |
| POST | `/api/tasks/{slug}/create` | `{title, body?, status?, priority?, after?}` |
| POST | `/api/tasks/{slug}/{id}/move` | `{status, comment?}`. 409 with `needsComment` when a comment is necessary |
| POST | `/api/tasks/{slug}/{id}/undo` | `{token}` from a move |
| POST | `/api/tasks/{slug}/{id}/note` · `edit` · `link` · `unlink` · `order` · `duplicate` | Task changes |
| POST | `/api/tasks/{slug}/{id}/attachments?name=` | Raw file body, 25 MiB at most |
| GET | `/api/files/{slug}/{task}/{name}` | An attached file |
| POST | `/api/projects/{slug}/summarize` · `archive-summary` · `archive-lane` · `done-lane` | Lane actions and summaries |
| GET, PUT | `/api/settings` · GET `/api/models` · GET `/api/rules` | Panel settings, model list, transition table for `user` |

A rule error returns 4xx with the CLI message: `{"ok":false,"error":"…","kind":"rule"}`. An unknown project or task returns 404.
