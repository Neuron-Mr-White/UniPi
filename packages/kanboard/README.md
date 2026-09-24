# @pi-unipi/kanboard

The pi half of **kanboard v3**: a per-project board for deferred work. The
storage, transition rules and web UI live in the Rust binary
([`crates/kanboard`](../../crates/kanboard) — one writer for every change); this
package is the terminal-side bridge: commands, the task runner, hub settings and
the `kanboard` skill.

Spec: [`docs/specs/2026-09-24-kanboard-v3-design.md`](../../docs/specs/2026-09-24-kanboard-v3-design.md).

## Commands

`/unipi:kanboard [open|onboard|add|work|stop|status]` (with arg completions):

| Sub | What it does |
|---|---|
| *(none)* / `open` | Ensure the daemon (reuse a healthy one, else spawn `serve` detached) and print `http://127.0.0.1:<port>/p/<slug>`. The browser opens only when `openBrowser` is on. |
| `onboard` | `project add` for this workspace, remembers the slug, reveals the skill, prints a 3-line how-to. Idempotent. |
| `add <text>` | Quick capture into Backlog — no agent turn. |
| `work` | Claim the next ready task and let the agent do it (below). |
| `stop` | Finish the current task, then stop. |
| `status` | Daemon pid/port, project counts, and the runner's current task. |

Any other text (`/unipi:kanboard buy milk`) is treated as a quick capture.

## Runner (`work`)

One job per session. The **runner owns the lifecycle transitions** the agent is
not allowed to write:

1. `claim-next --session <sid> --pid <ppid> --host <host> --gate <chainGate>` —
   nothing ready → `Nothing ready (N waiting on deps, M blocked)`.
2. **jev picks the mode** (one `choice` call over title + body ≤2000 chars):
   `direct` (small clear change) · `plan` (needs an approved plan) · `goal`
   (multi-turn objective with verification). jev null → `direct`; the choice is
   logged to `~/.unipi/logs/kanboard.log` with `UNIPI_DEBUG_KANBOARD=1`.
3. `set-run --mode`, then the task goes to the agent as a user message: title,
   body, last 10 activity entries, each dependency with its status and last note,
   and the rules (block with a comment to ask a question; never write
   `in_review`/`done`/`cancelled`; work only on this task).
   - **plan** → plan mode is entered through workflow's `unipi:plan-enter` runner
     first; approval stays interactive; a discarded plan releases the task to Todo
     with `plan discarded`.
   - **goal** → long-horizon's `unipi:goal-start` runner starts a goal with the
     task as the objective; the goal id is recorded with `set-run --goal` and
     completion is read back with `unipi:goal-status`.
4. Run end (a `/plan` settle after the last `agent_end`, once the agent reports
   idle with no queued messages): the task is re-read — if the agent blocked it,
   that is respected and reported (`▣ UNI-12 blocked: <comment>`) and the loop
   continues; otherwise `release --to in_review --comment <last assistant text
   ≤500 chars>`. `Esc` (aborted turn) → `release --to todo --comment "interrupted
   by user"` and the loop stops. Session shutdown → `release --to todo` with
   `session ended`.
5. After each task: `✓ UNI-12 → In Review: <first line>`, then the next task is
   claimed when `continue` is on (queued as a follow-up message; the event loop
   is never blocked).

Footer: `▣ UNI-12 · direct` while a task runs. The claimed task is persisted with
`pi.appendEntry("unipi:kanboard-runner", …)`, so `/reload` or a resume offers to
resume it or releases it to Todo.

## Settings (hub section "Kanboard")

| Setting | Default | Notes |
|---|---|---|
| `chainGate` | `in_review` | `done` waits for a finished dependency |
| `continue` | `true` | Claim the next task after each run |
| `idleMin` | `10` | Passed to `serve --idle-min` |
| `port` | `0` | Passed to `serve --port` (0 = OS-assigned) |
| `archiveAfterDays` | `0` | > 0 → `archive-sweep --after-days N` on session start (fire and forget) |
| `openBrowser` | `false` | Open the board in a browser on `open` |
| *actions* | | `Open board…`, `Stop daemon` |

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
reveal it on intent), and `onboard`/`work` force-reveal it by emitting
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
`daemon.lock` for the daemon, and `projects/<slug>/{project.json,board.lock,tasks/*.md}`.
The extension never edits those files — the binary owns them.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `kanboard binary unavailable for <platform>-<arch>` | No `UNIPI_KANBOARD_BIN`, no platform package and no dev build. Build `crates/kanboard` (`cargo build --release`) or set `UNIPI_KANBOARD_BIN`. |
| The board says *"N task file(s) need repair"* | A file was edited by hand. One bad file no longer blocks the board (it is skipped and reported); run `unipi-kanboard validate --fix`, then `validate`. |
| `UNI-5 is unreadable: … (line N)` | That task's own file is broken — repair it before moving/noting it. |
| The daemon looks stale | `unipi-kanboard status` (pid + liveness), then `unipi-kanboard stop` (SIGTERM, ≤3s) or the hub's **Stop daemon** action. |
| Nothing is ready | `unipi-kanboard list --ready --json` shows `waitingFor`; a cancelled dependency blocks forever — `link`/`unlink` to re-plan. |
| The runner prompts for permission on every board call | Fixed in auto mode: `unipi-kanboard … --actor agent` is allow-listed by the permission gate (ask mode still asks). |

## Tests

```bash
npm test -w packages/kanboard     # bin resolution, commands, runner, settings
```
