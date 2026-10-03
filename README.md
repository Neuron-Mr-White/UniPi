<p align="center">
  <img src="docs/assets/unipi-logo.png" width="220" alt="UniPi logo: Unicrab behind three terminal screens">
</p>

<h1 align="center">UniPi</h1>

<p align="center">
  <b>Extensions that make the Pi coding agent finish long work, remember it and show it.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pi-unipi/unipi"><img src="https://img.shields.io/npm/v/%40pi-unipi%2Funipi?label=npm&color=e8452c" alt="npm version"></a>
  <a href="https://github.com/Neuron-Mr-White/unipi/actions/workflows/ci.yml"><img src="https://github.com/Neuron-Mr-White/unipi/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/pi-%5E0.87.1-555" alt="Pi 0.87.1 or later">
</p>

<p align="center">
  <a href="docs/guide/getting-started.md">Getting started</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="docs/architecture/README.md">Architecture</a> ·
  <a href="docs/reference/commands.md">Commands</a> ·
  <a href="docs/story/unicrab.md">Meet Unicrab</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

## Install

```bash
pi install npm:@pi-unipi/unipi
```

UniPi needs [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
`0.87.1` or later. This command installs 21 extension packages. Each package
also works alone.

<p align="center">
  <img src="docs/assets/screenshots/simple-memory-glance.png" alt="A UniPi session in simple mode with memory recall, memory save and the glance footer">
</p>

This screenshot shows one turn in a demo session:

- **Simple mode** (the default) shows each tool call as one line.
- **Memory** finds the test setup from an earlier session and saves a new fact
  for later sessions.
- **The glance footer** frames the input box. It shows the git branch, the
  mode, the context use and the model. The strip below it shows turns, steps,
  wall time, tool time, time to first token, tokens per second and cache hits.

## Why UniPi

Pi is a small coding agent for the terminal. It reads files, edits files and
runs commands. UniPi adds the parts that a long session needs.

| UniPi gives you | How |
|---|---|
| **Memory between sessions** | Facts and decisions go to Markdown files and to a MemPalace index. |
| **Two models as one** | Fusion pairs a lead model with a sidekick model. |
| **Work that finishes** | `goal`, `ralph`, `swarm` and `graph` modes keep the agent on a long task. |
| **A warm prompt cache** | Changing state goes into new tail messages. The prefix stays the same. |
| **One driver for each turn** | A turn arbiter selects one continuation when the agent stops. |
| **Compaction with no model call** | The default `vcc` method rebuilds the summary from the full session history. |
| **Parallel hands** | Subagents and background tasks work while the lead continues. |
| **A board for deferred work** | Kanboard keeps tasks in Markdown files, with a web UI and a terminal UI. |
| **Hang detection** | Watchdog asks a small judge model about long tool calls. |
| **A short transcript** | Simple mode shows one line for each tool call. Ctrl+O expands it. |

## Proof

UniPi builds on methods that other teams measured. The numbers below come from
the linked sources. They are not UniPi benchmarks.

| Feature | What UniPi does | Published result |
|---|---|---|
| **Memory** | Stores each memory in [MemPalace](https://github.com/MemPalace/mempalace) for semantic search. | MemPalace reports 96.6% recall@5 on LongMemEval with raw semantic search and zero API calls. |
| **Fusion** | A lead model plans and reviews. A sidekick model does the routine work. | [Devin Fusion](https://cognition.com/blog/devin-fusion) uses the same lead-and-sidekick design. Cognition reports frontier-level FrontierCode scores at up to 60% lower cost. |
| **Fusion with two frontier models** | You can pair two frontier models in `/unipi:model`. | In [OpenRouter's test](https://openrouter.ai/blog/announcements/fusion-beats-frontier/), a panel of two frontier models scored 69.0% on DRACO. The best single model scored 65.3%. |
| **Goal** | Works over many turns until an independent verifier accepts the goal. | [Reflexion](https://arxiv.org/abs/2303.11366) loops on test feedback and raised HumanEval pass@1 from 80% to 91%. [Research on self-improving agents](https://arxiv.org/abs/2607.24300) shows that self-written checks can hide failures. UniPi therefore uses a separate verifier. |
| **Ralph** | Repeats a task loop over a checklist file until the agent completes every item. | The [Ralph loop](https://ghuntley.com/ralph/) by Geoffrey Huntley built the CURSED programming language. At a YC hackathon, teams [shipped six repositories overnight](https://paddo.dev/blog/ralph-wiggum-autonomous-loops/) for $297 in API cost. |
| **Swarm** | Sends independent items to parallel workers, then writes one summary. | In [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system), a lead agent with parallel subagents scored 90.2% higher than a single agent. |
| **Graph** | Plans dependent steps as a graph. Each step starts when its inputs are ready. | [LLMCompiler](https://arxiv.org/abs/2312.04511) (ICML 2024) plans tool calls as a dependency graph. It reports up to 3.7× lower latency, 6.7× lower cost and about 9% higher accuracy than ReAct. |
| **Prefix cache** | Keeps the system prompt, tools and earlier messages byte-identical. New state goes at the end. | A cached prefix [skips the prefill work again](https://handbook.modular.com/inference-optimization/prefix-caching/). [Anthropic reports](https://claude.com/blog/prompt-caching) up to 90% lower cost and 85% lower latency for long prompts. |

The [architecture pages](docs/architecture/README.md) show how each mechanism
works in UniPi, with the limits from the source.

## Kanboard

Kanboard is a task board for each project. You and the agent use the same
board. The agent claims a task, works it, and sends it to review with a
summary. You approve it or send it back with a note.

<p align="center">
  <img src="docs/assets/screenshots/kanboard-dashboard.png" alt="Kanboard dashboard: tasks waiting on you, running agents, ready tasks and a 14-day throughput chart">
</p>

The dashboard shows what needs you across all projects. You can approve a
review or answer a blocked question in one click.

<p align="center">
  <img src="docs/assets/screenshots/kanboard-board.png" alt="Kanboard board view with Backlog, Todo, In Progress, Blocked, In Review and Done lanes">
</p>

- Run `/unipi:kanboard open` to open the board in your browser.
- Run `/unipi:kanboard-add <title>` to add a task without an agent turn.
- Run `/unipi:kanboard-do <request>` to give the agent a budget of tasks and
  board writes.
- Run `/unipi:kanboard-autowork start` to let the agent work every ready task.

The screenshots use demo data. Read the [Kanboard README](packages/kanboard/README.md).

## Harness architecture

UniPi adds these mechanisms to the Pi harness. Each page gives the problem, a
diagram, the limits from the source, and the files to read.

| Mechanism | Problem it solves |
|---|---|
| [Event bus](docs/architecture/event-bus.md) | 21 packages must work together without import-time coupling. |
| [Turn arbiter](docs/architecture/turn-arbiter.md) | Several packages want to continue the run when the agent stops. Only one may act. |
| [Prefix cache](docs/architecture/prefix-cache.md) | One changed byte in the request prefix makes the provider bill the full context again. |
| [Compaction](docs/architecture/compaction.md) | A summary must keep the live task, and it must not grow at each compaction. |
| [Long-horizon](docs/architecture/long-horizon.md) | Multi-turn work needs one driver, a separate judge and hard budgets. |
| [Delegation](docs/architecture/delegation.md) | Work goes to other models and processes. Each one needs a known context boundary. |
| [Harness messages](docs/architecture/harness-messages.md) | Text from the harness reaches the model as user text. The user must see where it came from. |
| [Watchdog](docs/architecture/watchdog.md) | A timer cannot tell a hung command from a slow build. |

```mermaid
flowchart LR
  stop(["agent stops"]) --> arb{"turn arbiter<br/>1 nudge maximum"}
  arb -- "priority 100" --> lh["long-horizon<br/>goal · ralph · swarm · graph"]
  arb -- "priority 50" --> claims["kanboard<br/>claimed task"]
  arb -- "priority 40" --> auto["kanboard<br/>autowork"]
  lh --> tail["new tail message<br/>(prefix stays cached)"]
  claims --> tail
  auto --> tail
  tail --> next(["next turn"])
```

## Packages

| Area | Packages |
|---|---|
| Finish long work | [Long-Horizon](packages/long-horizon/README.md) · [Workflow](packages/workflow/README.md) · [Kanboard](packages/kanboard/README.md) |
| Keep context | [Compactor](packages/compactor/README.md) · [Memory](packages/memory/README.md) |
| Work in parallel | [Fusion](packages/fusion/README.md) · [Subagents](packages/subagents/README.md) · [Background Tasks](packages/background-tasks/README.md) · [BTW](packages/btw/README.md) |
| Reach outside | [Web API](packages/web-api/README.md) · [MCP](packages/mcp/README.md) · [Notify](packages/notify/README.md) |
| Stay safe | [Watchdog](packages/watchdog/README.md) · [Skill Registry](packages/skill-registry/README.md) · [Ask User](packages/ask-user/README.md) |
| See and control | [Footer](packages/footer/README.md) · [Info Screen](packages/info-screen/README.md) · [Input Shortcuts](packages/input-shortcuts/README.md) · [Command Enchantment](packages/autocomplete/README.md) |
| Maintain | [Utility](packages/utility/README.md) · [Updater](packages/updater/README.md) · [Core](packages/core/README.md) |

The [docs index](docs/README.md#packages) gives one line and the npm name for
each package.

## Meet Unicrab

<img align="right" src="docs/assets/unicrab-pixel.png" width="120" alt="Unicrab pixel art">

Unicrab is the UniPi mascot. It started as the author's pet crab. Now it says
hello when Pi starts and leaves hints above the input box. Press `Alt+H` for the
next hint.

Read [The making of Unicrab](docs/story/unicrab.md): from a real crab, to pixel
art, to a terminal character that is 7 columns wide.

<p align="center">
  <img src="docs/assets/screenshots/unicrab-start.png" alt="The UniPi start screen with Unicrab in half-block pixel art">
</p>

## Docs

- [Getting started](docs/guide/getting-started.md)
- [Commands](docs/reference/commands.md) · [Agent tools](docs/reference/tools.md) · [Shortcuts](docs/reference/shortcuts.md) · [Settings](docs/reference/settings.md) · [Glossary](docs/reference/glossary.md)
- [Architecture](docs/architecture/README.md)
- [All docs](docs/README.md)

The docs use STE-flavored English
([ASD-STE100](https://www.asd-ste100.org/)): short sentences, active voice and
one meaning for each word. The [style guide](docs/contributing/docs-style.md)
gives the rules.

## Development

```bash
git clone https://github.com/Neuron-Mr-White/unipi.git
cd unipi
npm install
npm run typecheck
npm test
```

To add a package:

1. Create `packages/<name>/` with a `package.json` and an `index.ts`.
2. Import events and constants from `@pi-unipi/core`.
3. Emit `MODULE_READY` when the package loads.
4. Add the package to `packages/unipi/index.ts` and to the root
   `package.json`.
5. Run `npm run typecheck` and `npm test`.

Packages talk over events and shared state holders. Import from
`@pi-unipi/core`, not from a peer package. The
[event bus page](docs/architecture/event-bus.md) explains the rules.

## Contributing

1. Fork the repository.
2. Create a branch.
3. Make your change.
4. Run `npm run typecheck` and `npm test`.
5. Open a pull request.

Keep one job in each package. For docs, follow the
[style guide](docs/contributing/docs-style.md).

## License

MIT © Neuron Mr White
