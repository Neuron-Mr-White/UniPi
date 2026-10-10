# Long-Horizon

Long-Horizon keeps the agent on a large task over many turns. It stops the agent
when the task finishes or cannot continue.

`@pi-unipi/long-horizon` · part of [UniPi](../../README.md)

## What it does

- Gives four modes for long work: `goal`, `ralph`, `swarm` and `graph`. The
  `none` mode is a normal session.
- Lets one owner control the session at a time. An owner is the active long-run
  task. One more owner can wait in the park slot.
- In `goal` mode, continues turns until an independent verifier accepts the goal.
  The goal can also stop as blocked, stalled or over budget.
- Shows only the tools of the current mode to the model.
- Can use a judge to select a mode for each new prompt. The judge is off by default.
- Shows a goal progress estimate to you only. The model does not get it.

| Mode | Use it for |
|---|---|
| `goal` | One objective that you can verify, over many turns. |
| `ralph` | A checklist file that the agent completes over many iterations. |
| `swarm` | Independent items that parallel workers do, then one summary. |
| `graph` | Steps where later steps need the results of earlier steps. |

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/long-horizon`.
2. Type `/unipi:goal <objective>`. The agent creates a goal and continues.
3. Type `/unipi:goal status` to see the owner and the progress.
4. Type `/unipi:goal stop` to end the goal.

## Commands

| Command | What it does |
|---|---|
| `/unipi:goal <prompt>` | Runs the prompt in `goal` mode. |
| `/unipi:ralph start <name> <content>` | Starts a loop with a Markdown checklist of `- [ ]` items. |
| `/unipi:ralph <prompt>` | Runs the prompt in `ralph` mode. |
| `/unipi:swarm <prompt>` | Runs the prompt in `swarm` mode. |
| `/unipi:graph <prompt>` | Runs the prompt in `graph` mode. |
| `/unipi:<mode> status` | Shows the owner, the park slot and the judge settings. |
| `/unipi:<mode> stop` | Ends the active owner. For `ralph`, it parks the loop. |
| `/unipi:<mode> resume` | Starts the parked owner again. |
| `/unipi:<mode> clear` | Removes the parked owner. |
| `/unipi:regular` | Ends the active owner. Sets the session to `none` mode. |

When you start a new mode, the active owner goes to the park slot. If the park
slot is full, the command fails. Resume or clear the parked owner first.

## Agent tools

Each tool shows only in its mode. `todowrite` shows in all four modes.

| Tool | Mode | What it does |
|---|---|---|
| `create_goal`, `get_goal`, `update_goal` | `goal` | Creates, reads and finishes the goal. Also changes the token budget. |
| `ralph_done`, `loop_status` | `ralph` | Ends one iteration. Reads the loop state. |
| `swarm_report`, `swarm_status`, `swarm_yield` | `swarm` | Records item results. Reads the state. Ends the turn while workers run. |
| `update_agent_graph`, `graph_output`, `view_agent_graph` | `graph` | Declares the graph. Records item results. Reads the graph. |
| `todowrite` | all | Replaces the visible task list. |

## Settings

Namespace `long-horizon`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `judge.enabled` | `false` | Lets the judge select a mode for new prompts. |
| `judge.threshold` | `0.8` | Minimum judge confidence. Below it, the default mode applies. |
| `decisionModel.source` | `inherit` | `inherit` uses the shared `decision-model` settings. `custom` sets a judge model. |
| `defaultMode` | `none` | Mode when the judge is off or gives no verdict. |
| `verifierModel` | empty | Model that verifies goal completion. Empty uses the session model. |
| `goalProgress` | `loop` | `loop` estimates after each goal turn. `status` estimates on status only. `off` stops it. |
| `progressModel` | empty | Model for the estimate. Empty uses the verifier model. |

## Judge keys and models

The judge finds its API key in this order:

1. The stored key (`/unipi:settings` → Decision Model → API key).
2. The environment: `TYPESAFE_API_KEY` for `typesafe`, `OPENROUTER_API_KEY`
   for `openrouter` and `custom`.
3. Pi's own model registry. If a Base URL is set, the judge uses the key of
   the pi model that has that Base URL. If no Base URL is set, it uses pi's
   stored key for the provider (`openrouter` or `typesafe`).

UniPi does not know about any one gateway or provider extension. A
third-party extension supplies keys and models through pi itself: it calls
`pi.registerProvider(name, { baseUrl, apiKey, models })`, or the user adds
the provider to `~/.pi/agent/models.json` / `auth.json`. Then set the
decision model's provider to `custom` and its Base URL to that provider's
URL (for example `https://gateway.example/v1`). The judge uses the key that
pi resolves for it. If no key is found, the judge is off and `defaultMode`
applies.

## How it works

At the start of each turn, the gate selects the mode. An explicit command wins.
Next comes the active owner, then the judge, then `defaultMode`. The gate adds
the mode prompt and filters the tool list. Within one mode, the tool list stays
the same, so the prefix cache stays valid.

The engine keeps owner state in `~/.unipi/workspace/<id>/state/long-horizon/`.
Ralph checklists are in the `ralph/` folder there. Owners do not start inside a
child agent.

Read [Long-horizon architecture](../../docs/architecture/long-horizon.md) and
[Turn arbiter](../../docs/architecture/turn-arbiter.md).

## See also

- [Delegation](../../docs/architecture/delegation.md)
- [Prefix cache](../../docs/architecture/prefix-cache.md)
- [Commands reference](../../docs/reference/commands.md)
- [Tools reference](../../docs/reference/tools.md)
