# @pi-unipi/watchdog

Jev watchdog for long-running tool calls and background tasks. Uses the TypeSafe System One Decision model (the same jev model the long-horizon mode router uses) to judge whether a running tool call or background task is stuck, and kills or warns accordingly.

Off by default. Configure in `/unipi:settings` → Watchdog.

## How it works

Every `intervalMin` minutes (default 5), the watchdog sends ONE jev request per watched item:

- **status** (choice): progressing / waiting / stuck / looping
- **persistent** (noul): is this a long-lived service operating normally?

A kill (or warn) fires when:

- status is **stuck** or **looping**
- confidence ≥ `confidence` (default 0.8)
- the persistent noul is < 0.5, **OR** the status is `looping` (an error loop is not healthy, even for a service)
- for `agreeChecks` (default 2) consecutive checks

The persistent veto protects dev servers, file watchers, and daemons that are operating normally. A loop that keeps printing errors is NOT healthy — it gets killed even if it looks like a service.

## What gets watched

| Item | Setting | Kill mechanism |
|---|---|---|
| bash tool calls | `watchBash` (default on) | process-group kill of the detected child shell |
| background tasks | `watchBgTasks` (default on) | `stopTask` via the shared registry |
| other tools (web, image, mcp, subagents) | `otherTools` (off/warn/abort-turn) | notify / abort turn |

**Never watched:** `ask_user` (human wait), quick tools (read/write/edit/grep/find/ls), persistent servers (no completion triggers configured).

## Settings

| Setting | Default | Description |
|---|---|---|
| `enabled` | `false` | Off by default — no timers run until enabled |
| `intervalMin` | `5` | Check interval in minutes |
| `firstCheckMin` | `2` | Minutes until the first check |
| `confidence` | `0.8` | Minimum jev confidence to act |
| `agreeChecks` | `2` | Consecutive agreeing checks before acting |
| `action` | `kill` | Kill the item, or only warn |
| `watchBash` | `true` | Watch bash tool calls |
| `watchBgTasks` | `true` | Watch background tasks |
| `otherTools` | `warn` | For tools without a kill handle: warn or abort the turn |

## Tool result annotation

When the watchdog kills a bash call, the tool result carries:

```
⚠ Killed by unipi watchdog after 95s: jev judged it stuck (confidence 0.92) on 2 consecutive checks — no new output for 95s. Do not blindly re-run; investigate or change approach.
```

The original output follows the warning. `isError` is set to `true`.

## Debug logging

Set `UNIPI_DEBUG_WATCHDOG=1` to enable debug logging to `~/.unipi/logs/watchdog.log`:

```
2026-09-23T09:46:58Z before_agent_start mode=judged skills=37
2026-09-23T09:46:58Z judged 37 -> 12 kept=[work, fix, ...] latency=376ms failOpen=false
```
