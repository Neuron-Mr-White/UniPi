# Background Tasks

Background Tasks runs long shell commands in the background, so the agent can
continue to work. When a task finishes, the agent gets a notice.

`@pi-unipi/background-tasks` · part of [UniPi](../../README.md)

## What it does

- Starts a named shell command and returns at once with a task ID and an output file.
- When the task stops, sends a `<background-task-notification>` message. By
  default, this message starts a new agent turn.
- Gives the agent bounded log reads, so large output does not fill the context.
- Stops a task when its output is more than 20 MiB.
- Shows a start card, a completion card and a Background tasks tab in the work tray.
- While the agent waits for a task, the footer shows one "Working…" line. Nothing else is drawn under the editor.

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/background-tasks`.
2. Ask the agent to run a long test suite in the background. The agent calls `bg_run`.
3. Push the down arrow in an empty input, or `Shift+Down`, to open the work tray. Background tasks is its first tab.

## Commands

| Command or key | What it does |
|---|---|
| `/unipi:bg [--agent] [--name "Name"] <command>` | Starts a background task. It sends a notice, but does not start a turn. |
| `/unipi:bg-tasks` | Opens the work tray on the Background tasks tab. |
| `Shift+Down` | Opens the work tray on the Background tasks tab. |
| `Ctrl+Alt+C` | Clears the notices of finished tasks. |

## The Background tasks tab

It looks like the Subagents tab. Running tasks come first, then recent ones.

| Key | What it does |
|---|---|
| `↑` `↓` | Moves the selection, or scrolls the log in the detail view. |
| `Enter` | Opens the detail view: the command, then the live log. |
| `l` | Opens the detail view with the full log (up to 4 MB). |
| `g` / `G` | Goes to the top, or back to the live end of the log. |
| `s` | Stops the task (SIGTERM, then SIGKILL after a grace period). |
| `x` `x` | Kills the task now (SIGKILL). Press `x` twice to confirm. |
| `a` `a` | Stops every running task. Press `a` twice to confirm. |
| `d` / `D` | Removes a finished task, or all finished tasks, from the list. |
| `R` | Runs the command again. |
| `c` | Shows the log path. |
| `←` / `Esc` | Goes back from the detail view. In the list, `←` `→` switch tabs and `Esc` closes. |

## Agent tools

| Tool | What it does |
|---|---|
| `bg_run` | Starts a named shell command. Set `isAgent` to `true` only for a command that starts an LLM agent. |
| `bg_status` | Shows the state of one task or all tasks at one time. |
| `bg_logs` | Reads bounded output from a task. |
| `bg_kill` | Stops a running task by ID. |

Do not call `bg_status` or `bg_logs` in a loop to wait. The notification
message is the final state of the task.

| `notifyOnCompletion` | `triggerOnCompletion` | Result |
|---|---|---|
| `true` | `true` (`bg_run` default) | A notice and a new agent turn. |
| `true` | `false` (`/unipi:bg` default) | A notice only. |
| `false` | any | No notice. Check the task yourself. |

## Settings

Namespace `background-tasks`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | Master switch. When it is `false`, the package registers no tools, commands or UI. |
| `notifyOnCompletion` | `true` | Sends a notice when a task stops. |
| `triggerOnCompletion` | `true` | Starts an agent turn when a task stops. |
| `defaultTimeoutSeconds` | `0` | Stops a task after this time. `0` means no limit. |
| `maxFinishedTasks` | `30` | Number of finished tasks to keep. |
| `maxOutputBytes` | `20971520` | Stops and fails a task above this output size. Minimum 1024. |

| Variable | What it does |
|---|---|
| `UNIPI_BG_TMP_DIR` | Folder for task output. The default is `TMPDIR` or `/tmp`. |
| `UNIPI_BG_MAX_OUTPUT_BYTES` | Default output limit. The `maxOutputBytes` setting wins. |
| `UNIPI_BG_SHELL`, `UNIPI_BG_SHELL_PATH` | On Windows, sets the shell: `cmd` or `bash`. |
| `UNIPI_BG_DISABLE_PI_TELEMETRY` | Set to `1` to stop the telemetry wrap of agent commands. |

Task output goes to `<tmp>/unipi-bg-tasks/<session>-<pid>-<nonce>/`.

## For other packages

Read the live task list without events:

```ts
import { getSharedTaskRegistry } from "@pi-unipi/background-tasks";

const tasks = getSharedTaskRegistry()?.allTasks() ?? [];
const running = tasks.filter((t) => t.status === "running").length;
```

The function returns `undefined` when the package is off. Treat that as "no data".

## How it works

Read [Turn arbiter](../../docs/architecture/turn-arbiter.md) and
[Harness messages](../../docs/architecture/harness-messages.md).

## See also

- [Subagents](../subagents/README.md)
- [Tools reference](../../docs/reference/tools.md)
- [Shortcuts reference](../../docs/reference/shortcuts.md)

Based on [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks)
(ISC license, Copyright Ismail).
