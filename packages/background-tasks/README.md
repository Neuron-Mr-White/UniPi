# @pi-unipi/background-tasks

Background tasks for UniPi — a full adoption of
[pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) into the
unipi conventions: durable background shell jobs, read-only delegated agents,
attested Pi runs, fixed-purpose multi-model Fusion workflows, and package-owned
Anthropic subscription attribution.

## Master toggle

One config key disables the entire module — no tools, no commands, no hooks, no UI:

```json
// ~/.unipi/config/background-tasks.json (global)
// <workspace>/.unipi/config/background-tasks.json (override; workspace wins)
{
  "enabled": true
}
```

Open `/unipi:bg-settings` for the interactive settings overlay (master toggle,
defaults, output caps, delegate/fusion defaults).

## Surfaces

### Tools (reference names kept)

| Tool | Purpose |
| --- | --- |
| `bg_run` | Start a named long-running shell command; terminal notification wakes a follow-up turn by default |
| `bg_status` / `bg_logs` / `bg_kill` | Point-in-time inspection, bounded log reads, stop — never polling primitives |
| `bg_delegate` + `bg_result` | One read-only child Pi agent seeded with a frozen projection of this conversation; hash-verified answer retrieval |
| `bg_run_pi_attested` | Evidence-oriented direct Pi spawn with local hashes and route attestation |
| `fusion_reason` | 3 candidates → blind evaluator → merger on the session projection |
| `fusion_investigate` / `fusion_research` / `fusion_validate` | Fixed-purpose multi-model workflows on clean-task input (inspect tools / caller-URL research / advisory review) |

### Commands (our namespace)

`/unipi:bg`, `/unipi:bg-clear`, `/unipi:bg-tasks`, `/unipi:bg-update`,
`/unipi:tasks`, `/unipi:jobs`, `/unipi:kill`, `/unipi:logs`,
`/unipi:bg-settings`, `/unipi:fusion`, `/unipi:fusion-models`,
`/unipi:claude-cache`.

Shortcuts: `Shift↓` opens the task manager dock; `Ctrl+Alt+C` clears finished notices.

## Storage layout (ours — never `.pi/`)

- Runtime artifacts (task output/metadata): `$TMPDIR/unipi-bg-tasks/<session>-<pid>-<nonce>/`
- Durable delegate artifacts: `<workspace>/.unipi/delegate/<session>-<pid>/<task-id>/`
- Durable fusion artifacts: `<workspace>/.unipi/fusion/<session>-<pid>/<run-id>/`
- Config: `~/.unipi/config/background-tasks.json` + workspace override
- Fusion model config: five-slot selector persisted through `/unipi:fusion-models`

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

## Attribution

`extensions/anthropic-attribution.ts` loads first (provider-gated): Claude Code
subscription OAuth attribution, exact-match system-prompt sanitization, and
cache-retention policy for Anthropic routes. Duplicate installed copies resolve
ownership through an EventBus claim; later copies go inert.

## Differences from the reference

- Commands live in the `/unipi:*` namespace; env prefix is `UNIPI_BG_*`.
- Runtime artifacts under the OS temp root (per-registry nonce) and durable
  delegate/fusion artifacts under workspace `.unipi/` — never `.pi/`.
- The reference's `update-check` footer surface is dropped (unipi's updater
  module owns updates).
- `agent_settled` / `before_provider_headers` hooks register defensively on our
  pi SDK with an `agent_end` settlement fallback.

ISC-licensed reference: Copyright Ismail <ismailsalikhodjaev@gmail.com>.
