# UniPi docs

This page is the map of the UniPi docs. GitHub shows it when you open the
`docs/` folder.

## Start here

- [Getting started](guide/getting-started.md): install UniPi and try the first
  commands.
- [The making of Unicrab](story/unicrab.md): how a pet crab became the mascot.
- [Main README](../README.md): what UniPi is, with screenshots.

## Packages

| Package | npm name | What it does |
|---|---|---|
| [Core](../packages/core/README.md) | `@pi-unipi/core` | Shared events, turn arbiter, settings engine and Unicrab hints. |
| [Workflow](../packages/workflow/README.md) | `@pi-unipi/workflow` | Plan mode and permission modes. |
| [Long-Horizon](../packages/long-horizon/README.md) | `@pi-unipi/long-horizon` | Goal, ralph, swarm and graph modes for multi-turn work. |
| [Kanboard](../packages/kanboard/README.md) | `@pi-unipi/kanboard` | A task board for each project, in the browser and in the terminal. |
| [Memory](../packages/memory/README.md) | `@pi-unipi/memory` | Memory that stays between sessions, with MemPalace search. |
| [Compactor](../packages/compactor/README.md) | `@pi-unipi/compactor` | Context compaction and session recall. |
| [Subagents](../packages/subagents/README.md) | `@pi-unipi/subagents` | Parallel agents that run in the background. |
| [Fusion](../packages/fusion/README.md) | `@pi-unipi/fusion` | A lead model and a sidekick model in one session. |
| [Background Tasks](../packages/background-tasks/README.md) | `@pi-unipi/background-tasks` | Commands that continue after the turn ends. |
| [Watchdog](../packages/watchdog/README.md) | `@pi-unipi/watchdog` | Stops or warns about tool calls that hang. |
| [Skill Registry](../packages/skill-registry/README.md) | `@pi-unipi/skill-registry` | Turns skills on or off for each project. |
| [Web API](../packages/web-api/README.md) | `@pi-unipi/web-api` | Web search and page reading. |
| [MCP](../packages/mcp/README.md) | `@pi-unipi/mcp` | Adds MCP servers and their tools. |
| [Notify](../packages/notify/README.md) | `@pi-unipi/notify` | Push notifications to your desktop or phone. |
| [Footer](../packages/footer/README.md) | `@pi-unipi/footer` | The glance frame and the live status strip. |
| [BTW](../packages/btw/README.md) | `@pi-unipi/btw` | Side questions in a separate session. |
| [Ask User](../packages/ask-user/README.md) | `@pi-unipi/ask-user` | Structured questions from the agent to you. |
| [Info Screen](../packages/info-screen/README.md) | `@pi-unipi/info-screen` | The Unicrab startup splash and the `/unipi:info` dashboard. |
| [Utility](../packages/utility/README.md) | `@pi-unipi/utility` | Diagnostics, session names, diff view and image tools. |
| [Updater](../packages/updater/README.md) | `@pi-unipi/updater` | Update checks, changelog and README browser. |
| [Input Shortcuts](../packages/input-shortcuts/README.md) | `@pi-unipi/input-shortcuts` | Chord shortcuts for the input box. |
| [Command Enchantment](../packages/autocomplete/README.md) | `@pi-unipi/command-enchantment` | Autocomplete for `/unipi:*` commands. |

The umbrella package `@pi-unipi/unipi` installs all of them.

## Reference

- [Commands](reference/commands.md): every slash command.
- [Agent tools](reference/tools.md): every tool that the model can call.
- [Keyboard shortcuts](reference/shortcuts.md).
- [Settings](reference/settings.md): where settings live and what they do.
- [Glossary](reference/glossary.md): UniPi terms.
- [Footer](../packages/footer/README.md): the glance frame and its settings.
- [Changelog](../CHANGELOG.md).

## Harness architecture

These pages explain how UniPi extends the Pi harness. Start with the
[overview](architecture/README.md).

- [Event bus](architecture/event-bus.md): how packages find each other.
- [Turn arbiter](architecture/turn-arbiter.md): who may continue a run when
  the agent stops.
- [Prefix cache](architecture/prefix-cache.md): how UniPi keeps the provider
  cache warm. The [full design](prefix-cache-architecture.md) has more detail.
- [Compaction](architecture/compaction.md): how the compactor keeps the live
  task.
- [Long-horizon](architecture/long-horizon.md): goals, loops and budgets.
- [Delegation](architecture/delegation.md): sidekicks, subagents, background
  tasks and side sessions.
- [Harness messages](architecture/harness-messages.md): how UniPi marks the
  text that it adds.
- [Watchdog](architecture/watchdog.md): how UniPi finds a tool call that hangs.

## Contributing

- [Docs style guide](contributing/docs-style.md): the STE-flavored English
  rules for these docs.
- [Register an extension](chore/register-extension.md).
- [Full release](chore/full-release.md).

## Contributor notebook

These folders hold the working notes behind each feature. They are records.
Some facts in them are old. The pages above are the current docs.

| Folder | Contents |
|---|---|
| [specs](specs/) | Design documents. |
| [plans](plans/) | Plans for each feature. |
| [research](research/) | Research and audits of code. |
| [audits](audits/) | Audits of ownership and behavior. |
| [debug](debug/) | Debug logs. |
| [fix](fix/) | Notes for each fix. |
| [quick-work](quick-work/) | Notes for small changes. |
| [context-gathered](context-gathered/) | Context notes for larger work. |

Other notes: [long-horizon design](long-horizon-design.md),
[long-horizon study](long-horizon-study.md),
[MemPalace migration](mempalace-memory-migration.md),
[DeepSeek cache research](deepseek-cache-rate-research.md),
[settings inventory](settings-inventory.md) and [v3 tasks](v3-tasks.md).
