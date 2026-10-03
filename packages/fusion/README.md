# Fusion

Fusion pairs a strong lead model with a lower-cost sidekick model, so the lead
plans and the sidekick does the routine work.

`@pi-unipi/fusion` · part of [UniPi](../../README.md)

## What it does

- Gives `/unipi:model`, a keyboard model picker. It shows all available models,
  their prices and a thinking level for each model.
- Lets you select one model, or a Fusion pair of a lead and a sidekick.
- Runs one persistent sidekick for each lead session. The sidekick is a child Pi
  process. Its context and shells stay between handoffs.
- Tells the lead to give work to the sidekick. In each turn, the first direct
  `edit` or `write` of the lead gets a reminder. Each 4 non-trivial `bash`
  calls of the lead also get a reminder.
- Shows the estimated savings of the sidekick in `/unipi:fusion-stats`.

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/fusion`.
2. Open `/unipi:settings`. Select "Edit fusion presets…". Mark the lead and
   sidekick models.
3. Type `/unipi:model`. Select the Fusion row. Push `Enter`.
4. Give the agent a task. The lead calls the `sidekick` tool.

## Commands

| Command | What it does |
|---|---|
| `/unipi:model` | Opens the model picker. When you type `/model`, the picker is the first suggestion. |
| `/unipi:fusion-stats` | Shows sidekick tokens, costs, savings, handoffs and runtime state. |

## Picker keys

| Key | What it does |
|---|---|
| Up, Down | Moves the selection. |
| Typing | Filters the models. |
| Left, Right | Changes the thinking level of the selected row. Fusion keeps the level for each model. |
| `Tab`, `Shift+Tab` | On the Fusion row, moves the focus: effort, lead, sidekick. |
| `Space` | On the Fusion row, selects lead effort or sidekick effort. |
| `Enter` | Applies the selection. |
| `Alt+Enter` | Saves the selected row as the startup model. |
| `Esc` | Closes the picker. |

If you change the model with Pi's own `/model` or `Ctrl+P`, Fusion mode stops.

## Agent tools

| Tool | What it does |
|---|---|
| `sidekick` | Gives a message to the sidekick. `block: true` (default) waits for the report. `block: false` returns now. The report comes later as a completion notice. |
| `read_subagent` | Reads or waits for a sidekick handoff. |

A call to `sidekick` while the sidekick works sends the message as an
interrupt. It does not start a second sidekick.

## Settings

Namespace `fusion`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `startup.model` | empty | Model that Pi opens with. Empty uses Pi's default. Global only. |
| `startup.thinking` | not set | Thinking level that Pi opens with. Global only. |
| `default.lead` | empty | Lead model when you confirm the Fusion row with no change. |
| `default.sidekick` | empty | Sidekick model for the same case. |

The preset file holds the model lists, levels, recent models and badges:

- Global: `~/.unipi/config/fusion/preset.json`
- Project: `<project>/.unipi/fusion-preset.json`. Its lists replace the global
  lists. Its objects merge with the global objects.

Add a `prices` object to the preset file when a provider gives no prices:

```json
{"prices": {"provider/model": {"input": 0.2, "cachedInput": 0.02, "output": 1.2}}}
```

## How it works

The sidekick session file is
`~/.unipi/workspace/<id>/sessions/<sid>/fusion/sidekick/<lead-session-id>.jsonl`.
The sidekick compacts its own context. The child gets `UNIPI_FUSION_CHILD=1` and
`UNIPI_SUBAGENT_CHILD=1`, so it does not load Fusion tools or commands.

Read [Delegation](../../docs/architecture/delegation.md) for the lead and
sidekick flow.

## See also

- [Subagents](../subagents/README.md)
- [Prefix cache](../../docs/architecture/prefix-cache.md)
- [Commands reference](../../docs/reference/commands.md)
