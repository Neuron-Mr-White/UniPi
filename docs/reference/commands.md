# Slash commands

This page lists every slash command that UniPi v3.0.0-alpha registers. The list
comes from the `pi.registerCommand` calls in the source.

## How to read this page

- Type each command in the Pi input box. All UniPi commands start with `/unipi:`.
- `<value>` is a value that you must give. `[value]` is optional.
- `a|b` means "type `a` or `b`".
- A command with no arguments in the table takes no arguments.
- Most commands need the interactive terminal UI. A command without the UI may
  only show a usage line.
- Terms such as goal, ralph and sidekick are in the [glossary](glossary.md).

Some flows have no slash command. You start them from a row in the settings hub
(`/unipi:settings`). Old docs name some of these flows as commands, for example
`/unipi:mcp-add`, `/unipi:notify-test` and `/unipi:web-cache-clear`. You cannot
type these names. See [Actions in the settings hub](#actions-in-the-settings-hub).

## [background-tasks](../../packages/background-tasks/README.md)

The package registers these commands only when its `enabled` setting is on.

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:bg` | `[--agent] [--name "Task name"] <command>` | Starts a shell command as a tracked background task. |
| `/unipi:bg-tasks` | `[task-id]` | Opens the background task manager. |

Use `--agent` only when the command starts an LLM agent process.

## [btw](../../packages/btw/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:btw` | `[question]` | Opens a side-question panel. The main agent never sees the question. |

## [compactor](../../packages/compactor/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:compact-vcc` | `[keep:N]` | Compacts the session now with a lossless summary. It makes no model call. |
| `/unipi:compact-by-llm` | `[focus text]` | Compacts the session now with a summary that a model writes. |
| `/unipi:session-recall` | `<query> [scope:all] [page:N]` | Searches this session, also the compacted parts. |
| `/unipi:compact-stats` | | Shows the compaction savings of this session. |
| `/unipi:compact-doctor` | | Checks the compaction settings and old files. |
| `/unipi:compact-help` | | Shows the compactor commands. |

`keep:N` keeps the last N turns. `scope:all` also searches edited or retried turns.

## [core](../../packages/core/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:hint` | `[next\|reset]` | Opens the hint browser. `next` shows the next hint. `reset` clears the hint history. |

## [footer](../../packages/footer/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:footer` | `[on\|off]` | Turns the footer on or off. With no argument, it toggles the footer. |

## [fusion](../../packages/fusion/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:model` | | Opens the model picker. Select one model, or a Fusion pair of a lead and a sidekick. |
| `/unipi:fusion-stats` | | Shows the estimated savings of the sidekick. |

When you type `/model`, autocomplete puts `/unipi:model` first.

## [info-screen](../../packages/info-screen/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:info` | `[page]` | Opens the dashboard: this session, context, usage, compaction savings and modules. |

## [kanboard](../../packages/kanboard/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:kanboard` | | Shows the kanboard command list. |
| `/unipi:kanboard open` | `[--host 127.0.0.1\|0.0.0.0\|tailscale] [--port N]` | Starts the board daemon and shows its link. |
| `/unipi:kanboard close` | | Stops the board daemon. |
| `/unipi:kanboard onboard` | | Registers this project on the board. |
| `/unipi:kanboard status` | | Shows the daemon, the projects and the claims. |
| `/unipi:kanboard show` | `[--all]` | Shows the board in the chat. |
| `/unipi:kanboard doctor` | | Checks the kanboard setup. |
| `/unipi:kanboard-add` | `[-p 1-5] [--after ID] [--status backlog\|todo] <title>` | Adds a task. Lines below the title become the description. |
| `/unipi:kanboard-do` | `<request>` or `off` | Gives the agent task slots and a write budget for one request. `off` takes the budget back. |
| `/unipi:kanboard-autowork` | `start\|stop` | Works ready tasks one at a time. `stop` lets the current task finish first. |

Priority `-p`: 1 none, 2 low, 3 medium, 4 high, 5 urgent. The old
subcommands `add`, `work` and `stop` only show a note that points to the new
commands.

## [long-horizon](../../packages/long-horizon/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:goal` | `<prompt>\|status\|stop\|resume\|clear` | Goal mode: one objective until a verifier accepts it. |
| `/unipi:ralph` | `start <name> [content]\|<prompt>\|status\|stop\|resume\|clear` | Ralph mode: a checklist that the agent works over many iterations. |
| `/unipi:swarm` | `<prompt>\|status\|stop\|resume\|clear` | Swarm mode: parallel items, then one synthesis. |
| `/unipi:graph` | `<prompt>\|status\|stop\|resume\|clear` | Graph mode: steps that need the results of earlier steps. |
| `/unipi:regular` | | Stops the active owner. Prompts then run with no long-horizon mode. |

The subcommands work the same in each mode:

| Subcommand | What it does |
|---|---|
| `<prompt>` | Runs the prompt in this mode. An active owner goes to the park slot first. |
| `status` | Shows the active owner, the parked owner and the judge settings. |
| `stop` | Ends the active owner. For ralph, `stop` parks the loop. |
| `resume` | Makes the parked owner active again. |
| `clear` | Deletes the parked owner. |

`/unipi:ralph start <name>` reads the task file `.unipi/ralph/<name>.md`. You can
also paste the task content after the name.

## [mcp](../../packages/mcp/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:mcp-status` | | Shows the status of each configured MCP server. |

Add, configure, sync and reload MCP servers from `/unipi:settings` → MCP.

## [memory](../../packages/memory/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:memory` | `[status\|migrate\|recall on\|off\|write on\|off]` | Shows the memory status. It also turns recall or write on or off for this session. |
| `/unipi:memory-process` | `<text>` | Reads the text and stores the memories in it. |
| `/unipi:memory-consolidate` | | Asks the agent to save this session into memory. |
| `/unipi:memory-search` | `<term>` | Searches the memories of this project. |
| `/unipi:global-memory-search` | `<term>` | Searches the memories of all projects. |
| `/unipi:memory-forget` | `<title>` | Deletes a memory by its title. |
| `/unipi:global-memory-list` | | Lists the memories of all projects. |

`/unipi:memory migrate` copies v2 memory data into MemPalace.

## [notify](../../packages/notify/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:notify-event` | `<event> on\|off` | Turns one notify event on or off without an overlay. |

Run `/reload` after `/unipi:notify-event` to apply the change.

## [skill-registry](../../packages/skill-registry/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:skills` | | Opens `/unipi:settings` at the Skills rows. |

## [subagents](../../packages/subagents/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:subagents` | | Opens the subagent panel. |
| `/unipi:agents` | | Lists, creates, edits, copies and deletes custom subagent profiles. |

## [updater](../../packages/updater/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:readme` | `[package]` | Opens the README browser. |
| `/unipi:changelog` | | Opens the changelog browser. |

## [utility](../../packages/utility/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:settings` | `[search]` | Opens the settings hub. A search term opens it with a filter. |
| `/unipi:continue` | | Continues the agent from where it stopped. It adds no text. |
| `/unipi:retry` | | Alias of `/unipi:continue`. |
| `/unipi:answer` | `[reply\|questions\|web]` | Opens a screen to answer the last agent reply. |
| `/unipi:summarize` | `[focus]` | Asks the agent for a summary of the session. It uses the bundled `summarize` skill. |
| `/unipi:doctor` | | Checks the UniPi folders, config, model cache, Decision Model and skills. |
| `/unipi:cleanup` | `[--dry-run] [--yes]` | Deletes old UniPi temp files. It shows a preview first. |

`/unipi:answer` modes:

- `reply` shows the reply above a fixed input box.
- `questions` gives one answer field for each question in the reply.
- `web` opens a browser form. It also works over SSH.

## [workflow](../../packages/workflow/README.md)

| Command | Arguments | What it does |
|---|---|---|
| `/unipi:plan` | `[on\|off\|view\|approve]` | Plan mode. With no argument, it toggles plan mode. |
| `/unipi:permission` | `[ask\|auto\|full\|status]` | Sets the permission mode for this project. With no argument, it shows the mode. |

In plan mode, the agent can only read files and write its plan file.

## Actions in the settings hub

These flows run from action rows in `/unipi:settings`. They have no slash
command.

| Hub group | Actions |
|---|---|
| Fusion | Edit fusion presets |
| Hints | Reset hint history |
| MCP | Configure servers, add a server, sync the catalog, reload servers |
| Notify | Send a test notification |
| Permission | Clear saved rules |
| Skills | Skill settings (Enabled and Must show for each skill) |
| Subagents | Manage agents |
| Utility | Rename the session now |
| Web API | Clear the web cache |

See [settings.md](settings.md) for the settings hub.
