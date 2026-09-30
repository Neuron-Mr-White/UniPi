# @pi-unipi/kanboard

The pi half of **kanboard v3**: a per-project board for deferred work. The
storage, transition rules and web UI live in the Rust binary
([`crates/kanboard`](../../crates/kanboard) — one writer for every change); this
package is the terminal-side bridge: commands, the `-do` budget, the turn
arbiter's kanboard monitor, hub settings and the `kanboard` skill.
**There is no runner** — the session works board tasks itself; the runner,
queue and strategy labels were removed (see
[`docs/plans/2026-09-30-01a0f095.md`](../../docs/plans/2026-09-30-01a0f095.md)).

Spec: [`docs/specs/2026-09-24-kanboard-v3-design.md`](../../docs/specs/2026-09-24-kanboard-v3-design.md)
(superseded for the runner/queue/strategy parts).

## Commands

`/unipi:kanboard [open|close|onboard|status|doctor]` — bare lists everything
(display-only, never enters the LLM context):

| Sub | What it does |
|---|---|
| `open [--host H] [--port N]` | Ensure the daemon (reuse a healthy one, else spawn `serve` detached) and print `http://127.0.0.1:<port>/p/<slug>`. The browser opens only when `openBrowser` is on. |
| `onboard` | `project add` for this workspace and remembers the slug. Idempotent. |
| `close` | Shut down the board daemon — the web UI goes offline until the next `open`. Running tasks are unaffected. |
| `status` | Daemon pid/port, project counts and active claims (session/pid/host/staleness). |
| `doctor` | ✓/✗ setup check (binary, daemon health, project, summary agent, bind, claims) as a display-only message. |

The other three commands are separate slash commands:

| Command | What it does |
|---|---|
| `/unipi:kanboard-add [-p 1-5] [--after ID] [--status backlog\|todo] <title>` | Capture a task — no agent turn. Lines below the title are the body; existing file paths pasted there are attached. `-p` maps 1 none · 2 low · 3 medium · 4 high · 5 urgent. |
| `/unipi:kanboard-do <request>` | Reveal the skill and hand the request to the agent with a **budget**: `doTasks` task slots (each `start` uses one) and `doWrites` board writes (add, edit, link, order, move backlog↔todo, note on tasks you don't hold). Always free: reads, and `finish`, `move <ID> blocked --comment` and `note` on tasks this session started. Budgets persist across turns until spent; `-do` tops up without stacking, `off` revokes. Children never write. |
| `/unipi:kanboard-autowork start\|stop` | `start` turns autowork on: the session works every ready task one at a time, in any mode it chooses, with no budget limits. `stop` turns the offers off (never aborts the current turn). |

The old `add`/`work`/`stop` subcommands and bare-text capture now just point at
these commands.

## Continuation: the turn arbiter's monitor

There is no runner loop. When a run settles, `src/monitor.ts` — a nudge
provider on core's turn arbiter (`agent_before_settle`) — proposes at most one
continuation:

- **Claims (priority 50):** a task this session started is still In Progress →
  `↻ UNI-30 still In Progress — continue, or finish/block it (n/5)`.
- **Autowork-next (priority 40):** autowork on, no open claims, a ready task
  exists → `↻ next ready: UNI-33 <title> …`; nothing ready → an
  `autowork done` notice, then autowork turns itself off.

The monitor defers to a **long-horizon owner** (priority 100), to **pending
events** and to **wait sources** (a running bg wake, a busy sidekick, a
background subagent). It **disarms** on an aborted/errored run (Esc never gets
talked over) and when a goal stops paused/budget with claims open (notice
only). Runaway guards: 2 nudged runs with zero tool calls → `⚠ stalled`, a
hard cap of 5 nudges per task, a question heuristic (the agent asked the user
something → notice, no nudge), and in autowork the same stall rule plus a
3-offers-per-task cap. After an Esc, a later prompt that names a claimed id
re-arms the monitor.

**Children are read-only.** Sidekicks and subagents may read the board; every
write is refused with "board writes are the lead's job — report this to the
lead". Reminders are silent there too.

**Session identity & lifecycle.** On every lead `session_start` the session id
becomes `UNIPI_KANBOARD_SESSION = pi-<pi session id>` (stable across `-c`/`-r`)
and `UNIPI_KANBOARD_PID` the process pid. At startup stale claims whose pid died
are reaped (`session lost: …`), and tasks released that way get a one-time
notice ("UNI-30 was released when the last run ended — ask me to re-start it").
On `session_shutdown` this session's open claims are released to Todo with
`released: session ended mid-task (<session>)` (actor system — the agent actor
cannot release).

## Settings (hub section "Kanboard")

| Setting | Default | Notes |
|---|---|---|
| `chainGate` | `in_review` | `done` waits for a finished dependency |
| `idleMin` | `10` | Passed to `serve --idle-min` |
| `port` | `0` | Passed to `serve --port` (0 = OS-assigned) |
| `archiveAfterDays` | `0` | > 0 → `archive-sweep --after-days N` on session start (fire and forget) |
| `openBrowser` | `false` | Open the board in a browser on `open` |
| `requireAuth` | `false` | Also require the access token on 127.0.0.1 (remote always does) |
| `keepToken` | `false` | Reuse `<home>/token` across daemon restarts |
| `maxSessions` | `2` | Distinct sessions holding in-progress tasks per project (`UNIPI_KANBOARD_MAX_SESSIONS`) |
| `turnAddLimit` | `20` | `add` calls allowed per turn (0 = unlimited) — the runaway guard, applies in autowork too |
| `reminders` | `true` | R1: steer on the first file-changing call while a mentioned task is still Todo (text only, never blocks; silent in child sessions) |
| `doTasks` | `5` | Task slots a `/unipi:kanboard-do` grants (each `start` costs one) |
| `doWrites` | `10` | Board writes a `/unipi:kanboard-do` grants; a stored `doCredits` migrates into this |
| *actions* | | `Open board…`, `Stop daemon`, `Summary agent command…`, `Rotate access token` |

`Summary agent command…` writes through `settings set agent-command` and
`Rotate access token` runs `rotate-token` — both are **user-only** (actor=agent
is refused), as are `settings set` calls generally. `settings show` is read-only.

## Binary resolution

1. `UNIPI_KANBOARD_BIN` (explicit path)
2. `@pi-unipi/kanboard-<platform>-<arch>/bin/unipi-kanboard[.exe]` (K4 ships these)
3. the dev build `<repo>/crates/kanboard/target/{release,debug}/unipi-kanboard`

Nothing found → every command reports
`kanboard binary unavailable for <platform>-<arch>` and does nothing else.

**Agent bash env:** pi has no extension-level mechanism to add env vars to the
`bash` tool (only replacing bash via `registerTool` + `BashToolOptions`, which
would change tool schemas mid-session and break the prefix cache — spec principle
4 forbids that). So the task prompt and the skill pass `--actor agent --project
<slug>` explicitly and call the binary by absolute path.

## Skill

`skills/kanboard/SKILL.md` describes the CLI, the lanes, who may move what, and
the rules agents must follow. It is a normal pi skill (jev skill-judging can
reveal it on intent), and `/unipi:kanboard-do` force-reveals it by emitting
`unipi:skills:reveal`, which utility turns into the usual append-only reveal
message — the system prompt is never touched.

## Platforms and packaging

| Platform | npm package | Rust target | Notes |
|---|---|---|---|
| Linux x64 | `@pi-unipi/kanboard-linux-x64` | `x86_64-unknown-linux-musl` | static-pie, 3.9 MB |
| Linux arm64 | `@pi-unipi/kanboard-linux-arm64` | `aarch64-unknown-linux-musl` | static |
| macOS arm64 | `@pi-unipi/kanboard-darwin-arm64` | `aarch64-apple-darwin` | |
| macOS x64 | `@pi-unipi/kanboard-darwin-x64` | `x86_64-apple-darwin` | cross-built from macos-14 |
| Windows x64 | `@pi-unipi/kanboard-win32-x64` | `x86_64-pc-windows-msvc` | |

They are **optional dependencies** of this package (`os`/`cpu` gated), so `npm install`
pulls exactly one. `.github/workflows/kanboard-binaries.yml` builds them (tests +
clippy on native targets, release build per target, artifact per platform) and, on
a `v*` tag, attaches the binaries to the GitHub release. Publishing to npm:

```bash
npm run publish:kanboard -- --dry-run   # what would ship
npm run publish:kanboard                # publishes, or skips loudly
```

The script **skips any platform package whose `bin/` is empty** (and exits 2), so
an empty platform package can never be published. CI publishes only when an
`NPM_TOKEN` secret exists — this repository has none, so the release job attaches
artifacts and says so.

Local packaging proof (no registry, no network):

```bash
node scripts/test-kanboard-packaging.mjs
# packs packages/kanboard + the linux-x64 platform package, installs both into a
# temp node_modules, resolves the binary through src/bin.ts and runs --version
```

## Remote access

The daemon binds `127.0.0.1` by default — local only, no token. For access from
another machine either **tunnel** it (nothing to configure):

```bash
ssh -N -L 37473:127.0.0.1:37473 <hostname>   # then open http://127.0.0.1:37473
```

…or bind a reachable interface, which turns on the **token gate**:

```bash
/unipi:kanboard open --host 0.0.0.0 --port 37473     # every interface
/unipi:kanboard open --host tailscale                # the tailnet IPv4
```

`--host` and `--port` override the `host`/`port` settings for that invocation
only. `tailscale` resolves through `tailscale ip -4` (clear error when tailscale
is not installed). For a wildcard bind the printed URLs cover the machine
hostname, every non-internal IPv4 and the tailnet address, and a warning says
`board is reachable from the network; anyone with the link can edit it`.

**Token model.** Any non-loopback bind generates a 32-byte token (base64url) and
writes it to `daemon.json` alongside `host`. Every request must carry it:

- `?t=<token>` — sets an `HttpOnly; SameSite=Strict` cookie and 303-redirects to
  the same URL without the parameter (so the token leaves the address bar),
- the `kb_token` cookie, or
- `Authorization: Bearer <token>`.

Missing or wrong tokens answer `401` with a page saying to open the link printed
by `/unipi:kanboard open`. `/api/health` stays reachable but returns only
`{ok, version}` (no pid) off-loopback, and POSTs are refused when their `Origin`
does not match the request `Host` (drive-by CSRF), in both modes. Loopback binds
keep no token at all.

Changing the binding needs a restart: if a daemon already runs with a different
host/port, `serve` reports `bindingChanged` and `/unipi:kanboard open` stops the
old one and starts the new one (`restarted kanboard on 0.0.0.0:37473`). The
daemon runs no jobs, so nothing is lost.

## Storage

`~/.unipi/kanboard/` (`UNIPI_KANBOARD_HOME` overrides it): `daemon.json` +
`daemon.lock` for the daemon, and `projects/<slug>/{project.json,board.lock,tasks/*.md,queues/<session>.json}`.
The extension never edits those files — the binary owns them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `kanboard binary unavailable for <platform>-<arch>` | No `UNIPI_KANBOARD_BIN`, no platform package and no dev build. Build `crates/kanboard` (`cargo build --release`) or set `UNIPI_KANBOARD_BIN`. |
| The board says *"N task file(s) need repair"* | A file was edited by hand. One bad file no longer blocks the board (it is skipped and reported); run `unipi-kanboard validate --fix`, then `validate`. |
| `UNI-5 is unreadable: … (line N)` | That task's own file is broken — repair it before moving/noting it. |
| The daemon looks stale | `unipi-kanboard status` (pid + liveness), then `/unipi:kanboard close`, `unipi-kanboard stop` (SIGTERM, ≤3s) or the hub's **Stop daemon** action. |
| Nothing is ready | `unipi-kanboard list --ready --json` shows `waitingFor`; a cancelled dependency blocks forever — `link`/`unlink` to re-plan. |
| A board call prompts for permission | Fixed in auto mode: `unipi-kanboard … --actor agent` is allow-listed by the permission gate (ask mode still asks). |

## Tests

```bash
npm test -w packages/kanboard     # bin resolution, commands, budget guard, monitor, settings
```
