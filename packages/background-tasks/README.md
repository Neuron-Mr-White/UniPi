# @pi-unipi/background-tasks

Background tasks for UniPi — durable background shell jobs plus one read-only
delegated background agent, with a footer dock the user can manage while the
agent keeps working. Originally adopted from
[pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks);
the Fusion council, attested Pi runs, and Anthropic attribution surfaces were
removed in 2.17.0 so the module does exactly one thing.

## Master toggle

One config key disables the entire module — no tools, no commands, no hooks, no UI:

```json
// ~/.unipi/config/background-tasks.json (global)
// <workspace>/.unipi/config/background-tasks.json (override; workspace wins)
{
  "enabled": true
}
```

Open `/unipi:settings` (Background Tasks group) for the master toggle,
defaults, output caps, delegate defaults).

## Surfaces

### Tools

| Tool | Purpose |
| --- | --- |
| `bg_run` | Start a named long-running shell command; terminal notification wakes a follow-up turn by default |
| `bg_status` / `bg_logs` / `bg_kill` | Point-in-time inspection, bounded log reads, stop — never polling primitives |
| `bg_delegate` + `bg_result` | One read-only child Pi agent seeded with a frozen projection of this conversation; hash-verified answer retrieval |

### Commands

`/unipi:bg` (start a shell task), `/unipi:bg-tasks` (open the dock),
`/unipi:settings` (Background Tasks group).

Shortcuts: `Shift↓` opens the task manager dock; `Ctrl+Alt+C` clears finished notices.

## What the user sees

- **Launch card** — `bg_run` results render as a tinted card (`● bg started <name> · wakes agent on completion`) so the start of a task is visible in the transcript.
- **Pending-wake line** — while the agent is idle but a task that will wake it is still running, a spinner line sits above the editor: `⠋ waiting on 1 bg task · <name> 12s — agent resumes automatically when done`. Without this the UI looks finished and users assume the turn is over.
- **Completion card** — the terminal notification renders as a tinted card (`✓ bg done <name> · exit 0 · 25s · agent woken`) with the last three output lines. Failed / stopped tasks use the error tint.
- **Dock** (`Shift↓`) — rows show `⏰ wakes agent` for tasks that will resume the agent, and the last output line for running shell tasks.

## Storage layout (ours — never `.pi/`)

- Runtime artifacts (task output/metadata): `$TMPDIR/unipi-bg-tasks/<session>-<pid>-<nonce>/`
- Durable delegate artifacts: `<workspace>/.unipi/delegate/<session>-<pid>/<task-id>/`
- Config: `~/.unipi/config/background-tasks.json` + workspace override

## Environment

`UNIPI_BG_*` prefix (replaces the reference `PI_BG_*`):
`UNIPI_BG_TMP_DIR`, `UNIPI_BG_MAX_OUTPUT_BYTES`, `UNIPI_BG_SHELL`,
`UNIPI_BG_SHELL_PATH`, `UNIPI_BG_DISABLE_PI_TELEMETRY`, `UNIPI_BG_DELEGATE_*`.

## Completion delivery

| `notifyOnCompletion` | `triggerOnCompletion` | Mode |
| --- | --- | --- |
| true (default) | true (bg_run default) | Durable terminal notification + automatic follow-up turn |
| true | false (`/unipi:bg` default) | Notification only |
| false | — | Manual monitoring |

Treat `<background-task-notification>` as durable terminal truth — do not poll.

## Shared registry (for sibling extensions)

Other packages can read the live task registry synchronously — no events, no polling:

```ts
import { getSharedTaskRegistry } from "@pi-unipi/background-tasks";

const tasks = getSharedTaskRegistry()?.allTasks() ?? [];
const running = tasks.filter((t) => t.status === "running").length;
```

The registry is published on `globalThis` under a `Symbol.for` key at extension
init and `session_start`, and cleared on `session_shutdown` (counts are
per-session). Returns `undefined` when the module is disabled — callers must
treat that as "no data", e.g. the footer's glance process line does.

## Differences from the reference

- Commands live in the `/unipi:*` namespace; env prefix is `UNIPI_BG_*`.
- Runtime artifacts under the OS temp root (per-registry nonce) and durable
  delegate artifacts under workspace `.unipi/` — never `.pi/`.
- The reference's `update-check` footer surface is dropped (unipi's updater
  module owns updates).
- Removed: attested Pi runs, the five-slot Fusion council tools, and the
  Anthropic attribution provider override.

ISC-licensed reference: Copyright Ismail <ismailsalikhodjaev@gmail.com>.
