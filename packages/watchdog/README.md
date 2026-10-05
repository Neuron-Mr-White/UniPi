# Watchdog

Watchdog finds tool calls and background tasks that look stuck. By default it returns a foreground bash call early while keeping its process running as a background task.

`@pi-unipi/watchdog` · part of [UniPi](../../README.md)

## What it does

- Watches running `bash` calls, background tasks and other long tools.
- Asks jev, the UniPi Decision Model, if each item is progressing, waiting, stuck or looping.
- Acts only after 2 checks in a row agree, using a stop score of 0.5 (bash) or status confidence of 0.5 (other items).
- Protects dev servers, file watchers and daemons that run normally.
- Gives the agent the background task ID, captured output and reason, so it can use `bg_logs`, `bg_kill`, or carry on.
- Never automatically judges or kills a task it moved to the background.
- Is off by default. No timers run until you turn it on.

## Quick start

Watchdog ships in `@pi-unipi/unipi`. To install it alone:

```bash
pi install npm:@pi-unipi/watchdog
```

1. Type `/unipi:settings`.
2. Open the Watchdog group.
3. Set `enabled` to on.
4. Start a new session. Watchdog starts its timer at session start.

`/unipi:bg-detach [reason]` manually moves the most recently started foreground bash call to the background. It works independently of the automatic watchdog setting. Watchdog has no agent tools.

## What it watches

| Item | Setting | Action |
|---|---|---|
| `bash` tool calls | `watchBash` | Returns the call early and adopts its process as a background task by default. |
| Background tasks | `watchBgTasks` | Stops the task through the background task registry. |
| Other tools (web, image, MCP, subagents) | `otherTools` | Warns, or aborts the turn. |

Watchdog never watches `read`, `write`, `edit`, `grep`, `find`, `ls`, `ask_user`, `read_subagent`, `bg_kill` or `bg_tasks`. It also skips a background task that has no completion trigger, because that task is a server.

## Settings

Open `/unipi:settings` → Watchdog. The namespace is `watchdog`.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `false` | Turns the watchdog on. |
| `intervalMin` | `3` | Minutes between two checks of one item. |
| `firstCheckMin` | `2` | Minimum age of an item, in minutes, before its first check. |
| `confidence` | `0.5` | Stop score for bash; status confidence for background tasks and other tools. Range 0 to 1. |
| `agreeChecks` | `2` | Number of checks in a row that must agree. |
| `action` | `background` | `background` returns bash early without killing; `kill` stops it; `warn` leaves it running and queues a warning. |
| `watchBash` | `true` | Watches `bash` calls. |
| `watchBgTasks` | `true` | Watches background tasks. |
| `otherTools` | `warn` | `off`, `warn` or `abort-turn` for tools that Watchdog cannot stop. |

The group also has a Decision model section. Set `decisionModel.source` to `inherit` or `custom`.

`action` applies to `bash` calls only. Ordinary stuck background tasks retain the existing stop behavior even when `action` is `warn`; watchdog-adopted tasks are excluded entirely.

## How a bash call is judged

Bash calls use Linux process activity plus jev's stop question. A call triggers when:
- Two checks are idle with no CPU, disk or output activity, and no sleeping process.
- The stop score meets the threshold for the configured consecutive checks.
- Jev expects the command to finish within seconds, but it has reached its first watchdog check.

An explicit `timeout`, chained `sleep`, or bounded `seq`/`sleep` loop vetoes every trigger until its declared time bound expires. Missing process samples never count as idle. Background tasks and other tools retain the existing status-based decision path.

## How it works

1. A timer runs every 15 seconds or less. It does not call jev until an item is due.
2. For each due item, Watchdog sends jev the command and its run time. It also sends the time since new output, and the last 3,000 characters of output.
3. jev answers two questions. `status` is one of `progressing`, `waiting`, `stuck` or `looping`. `persistent` scores if the item is a service that runs normally.
4. Watchdog acts when all of these are true:
   - `status` is `stuck` or `looping`.
   - The confidence is at or above `confidence`.
   - The item is not a normal service. A `looping` item is never a normal service.
   - `agreeChecks` checks in a row agree.

Utility wraps pi's local bash operations in every render style. When detaching, the background-task registry takes ownership of the same child, output stream and original start time. The tool returns normally; completion later sends the normal background notification and wakes the agent. Esc after detachment does not stop the adopted command. Background-task shutdown cleanup and `bg_kill` still apply.

If adoption is unavailable (for example, background-tasks is disabled), automatic `background` falls back to the existing kill path: it stops the process group only when exactly one child matches the command. With zero or many matches, or on Windows, it queues a warning. Explicit `kill` uses that same path.

The tool result of a stopped call starts with a line like this:

```
⚠ Killed by unipi watchdog after 410s: jev judged it judged stuck; stuck (confidence 0.92) on 2 consecutive checks — no new output for 300s. Do not blindly re-run; investigate or change approach.
```

The original output follows. The result has `isError: true`. Warnings go to the agent at the start of the next turn. While Watchdog watches items, the status bar shows `watchdog: N`.

## Debug log

For action-path testing, `UNIPI_WATCHDOG_FORCE_ACT=1` forces an act decision at a due check; normal decision prompting and thresholds are otherwise unchanged. Do not enable this in normal sessions.

Set `UNIPI_DEBUG_WATCHDOG=1` to write a log to `~/.unipi/logs/watchdog.log`. Each check writes one line with the status, the confidence and the streak.

## See also

- [Watchdog architecture](../../docs/architecture/watchdog.md)
- [Background Tasks](../background-tasks/README.md)
- [Settings reference](../../docs/reference/settings.md)
- [Glossary](../../docs/reference/glossary.md)
