# Subagents

Subagents let the agent give a self-contained task to a child agent, so the
main context stays small.

`@pi-unipi/subagents` · part of [UniPi](../../README.md)

## What it does

- Starts each child agent as a separate Pi process (`pi --mode rpc`).
- Runs a child in the foreground, or in the background. A background child
  sends one completion notice when it finishes.
- Can resume an earlier child in its own session.
- Gives two built-in profiles and lets you add custom agents as Markdown files.
- Shows a live card for each child, with the model, tool calls, tokens and cost.
- Runs 8 children or fewer at the same time by default.

| Profile | What it does |
|---|---|
| `subagent_explore` | Read-only research. It uses the default subagent model. |
| `subagent_general` | General tasks, also code changes. It uses your model. |

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/subagents`.
2. Ask the agent to explore a part of the code with a subagent.
3. Push `Ctrl+B` to send a foreground child to the background.
4. Push the down arrow in an empty input to open the subagent panel.

## Commands

| Command or key | What it does |
|---|---|
| `/unipi:subagents` | Opens the subagent panel. |
| `/unipi:agents` | Lists profiles. Creates, edits, copies or deletes custom agents. |
| `Ctrl+B` | Sends all foreground children to the background. |
| `Esc` | Cancels a foreground child. |

In the panel, use the arrow keys to move. Push `Enter` to see the live
transcript. Push `f` to bring a child to the foreground. Push `x` to cancel it.

## Agent tools

| Tool | What it does |
|---|---|
| `run_subagent` | Starts a child with a `title`, `task` and `profile`. Use `is_background` to run without a wait. Use `resume` with an agent ID to continue a child. |
| `read_subagent` | Reads the report of a subagent or a Fusion sidekick. |

A background child cannot show approval prompts. A denied call returns a reason
to the child. A foreground child sends its prompts to you.

## Settings

Namespace `subagents`. Open it with `/unipi:settings`. The package reads the
settings and agent files again each turn, so you do not need to restart Pi.

| Key | Default | What it does |
|---|---|---|
| `enabled` | `true` | Gives `run_subagent` and `read_subagent` to the agent. |
| `defaultModel` | empty | Model for `subagent_explore` and custom agents with no model. Empty uses the Fusion sidekick, then your model. |
| `defaultThinking` | `inherit` | Thinking level for the same agents. |
| `maxConcurrent` | `8` | Maximum children that run at the same time. Range 1 to 16. |

Set `UNIPI_SUBAGENT_MAX_DEPTH` to let children start children. The default is
`1`, which means no nesting.

## Custom agents

Put a Markdown file in `~/.unipi/config/agents/` or in
`<project>/.unipi/config/agents/`. The project file wins. The body is the system
prompt. The front matter can have these keys: `name`, `description`, `model`,
`tools` or `allowed-tools`, `thinking` and `max-nesting`.

The package keeps child sessions in
`~/.unipi/workspace/<id>/state/subagents/sessions/<lead-session-id>/`.

## How it works

Read [Delegation](../../docs/architecture/delegation.md) and
[Harness messages](../../docs/architecture/harness-messages.md).

## See also

- [Fusion](../fusion/README.md)
- [Background tasks](../background-tasks/README.md)
- [Tools reference](../../docs/reference/tools.md)
