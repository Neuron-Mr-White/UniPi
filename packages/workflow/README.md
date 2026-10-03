# Workflow

Workflow controls which tool calls the agent can run without your approval, and
gives a read-only plan mode.

`@pi-unipi/workflow` · part of [UniPi](../../README.md)

## What it does

- Checks each tool call against a permission mode: `ask`, `auto` (default) or `full`.
- In `auto` mode, sends an unknown `bash` command to jev for a risk verdict.
  Jev is the UniPi decision model: one small LLM call that returns a choice and
  a confidence.
- Saves "Always allow" rules for each project. Saved deny rules apply in all modes.
- Gives plan mode. In plan mode, the agent can only read files and write one plan file.
- Shows the plan in a review screen. You approve it, ask for changes or discard it.

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/workflow`.
2. Push `Alt+M` to change the permission mode.
3. Push `Alt+P` to start plan mode. Ask the agent for a plan.

## Commands

| Command or key | What it does |
|---|---|
| `/unipi:permission` | Shows the current mode, the project mode and the default mode. |
| `/unipi:permission ask\|auto\|full` | Sets the mode for this project. |
| `Alt+M` | Cycles the mode: `ask`, `auto`, `full`. |
| `/unipi:plan` | Starts or stops plan mode. |
| `/unipi:plan on\|off` | Starts or stops plan mode. |
| `/unipi:plan view` | Shows the plan file. |
| `/unipi:plan approve` | Opens the plan review screen. |
| `Alt+P` | Starts or stops plan mode. |

## Agent tools

| Tool | What it does |
|---|---|
| `plan_submit` | Plan mode only. Opens the plan review screen for the user. |

## Permission modes

| Mode | What runs without a prompt |
|---|---|
| `ask` | Read-only tools only. All other calls show a prompt. |
| `auto` | Read-only tools, read-only `bash`, and writes in the project or the temp folder. Jev checks other `bash` commands. |
| `full` | All calls, also dangerous `bash`. Saved deny rules still block. |

The gate checks a tool call in this order:

1. Saved rules. A deny rule blocks the call. An allow rule runs it.
2. Read-only tools, such as `read`, `grep`, `ls`, `memory_search` and `bg_status`.
3. `write` and `edit`. A path outside the project and the temp folder shows a
   prompt in `ask` and `auto` modes.
4. `bash`. Dangerous patterns, such as `rm -rf`, `sudo` or `git push --force`,
   show a prompt in `ask` and `auto` modes. In `auto` mode, jev must say `safe`
   with a confidence of `jevConfidence` or more. Otherwise, you get a prompt.
5. Other tools. They run in `auto` and `full` modes.

The prompt gives four options: "Allow once", "Always allow", "Deny" and "Deny
with note". The agent gets your note in the block reason.

When there is no UI, nothing shows a prompt. The gate blocks dangerous `bash`
and saved deny rules. It runs all other calls.

## Plan mode

- The plan file is `docs/plans/<date>-<session-id>.md` in the project.
- The agent can write only the plan file. `bash` must be read-only. Other tools
  that change state get a block message.
- Each turn gets a short reminder message. The system prompt does not change.
- "Approve & implement" stops plan mode. It sends the plan as the next user message.
- "Keep planning" sends your feedback to the agent.

## Settings

Namespace `permission`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `mode` | not set | Mode for this project. Project scope only. |
| `defaultMode` | `auto` | Mode for projects that set no mode. Global scope only. |
| `jevJudge` | `true` | Lets jev check unknown `bash` commands in `auto` mode. |
| `jevConfidence` | `0.7` | Minimum confidence for a `safe` verdict. |
| `rules` | `[]` | Saved allow and deny rules. The hub has a "Clear saved rules" action. |
| `decisionModel.source` | `inherit` | `inherit` uses the shared `decision-model` settings. `custom` sets a model for this namespace. |

Set `UNIPI_DEBUG_PERMISSION=1` to write each decision to
`~/.unipi/logs/permission.log`.

## See also

- [Commands reference](../../docs/reference/commands.md)
- [Shortcuts reference](../../docs/reference/shortcuts.md)
- [Harness messages](../../docs/architecture/harness-messages.md)
- [Skill registry](../skill-registry/README.md) has the old workflow skills.
