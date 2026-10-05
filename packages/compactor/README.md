# Compactor

Compactor makes the context smaller when it fills up, so long work can continue.
The full history stays in the session file, and the agent can search it.

`@pi-unipi/compactor` · part of [UniPi](../../README.md)

## What it does

- Replaces old messages with a summary when the context fills up.
- The default method, lossless, makes the summary with 0 model calls.
- The model summary method uses Pi's model-written summary. It adds the active
  work block at the top. It costs one model call.
- Makes each lossless summary again from the full history. It does not merge
  old summaries, so the summary does not grow over time.
- Removes passwords, API keys and bearer tokens from the summary.
  `session_recall` can still find them.
- Shows a compaction card in the chat and a compaction count in the footer.

## Quick start

1. Install UniPi: `pi install npm:@pi-unipi/unipi`. You can also install this
   package alone: `pi install npm:@pi-unipi/compactor`.
2. Work as usual. Compaction starts at Pi's context limit.
3. Type `/unipi:compact-stats` to see the tokens that compaction saved.

## Commands

| Command | What it does |
|---|---|
| `/unipi:compact-vcc [keep:N]` | Runs lossless compaction now. `keep:N` keeps the last N user turns. |
| `/unipi:compact-by-llm [focus]` | Runs model summary compaction now. The text sets the focus of the summary. |
| `/unipi:session-recall <query>` | Searches the full session history. Add `scope:all` or `page:N`. |
| `/unipi:compact-stats` | Shows the compactions and the saved tokens of this session. |
| `/unipi:compact-doctor` | Checks the settings, Pi's compaction switch and old files. |
| `/unipi:compact-help` | Shows a list of compactor commands. |
| `/unipi:compact-then [prompt]` | Compacts, then sends `prompt` once it lands. Not a registered command — the package adds its own single autocomplete entry for it. |

`/unipi:compact-then` works idle or while the agent is streaming. Idle, it
compacts now and queues the prompt as a follow-up. Streaming, it queues the
compaction for the next turn boundary and delivers the prompt the same way you
submitted it — as a steer (Enter) or a follow-up (Alt+Enter) — once that
turn's own compaction lands. With no prompt, it just compacts.

## Agent tools

| Tool | What it does |
|---|---|
| `session_recall` | Searches the session with keywords or a regex. It also finds messages that compaction removed. `expand` gives full entries by index. |
| `context_budget` | Gives the percent of the context in use and the tokens left. |

## Lossless summary

The summary has these sections. Each section gets a part of a token budget. The
auto budget is 1.5k to 4k tokens. It grows with the session size.

1. Active Work: the goal, ralph loop or kanboard task that runs now.
2. Your Requests: your messages and your `ask_user` answers.
3. Latest State: the last step and the last progress report.
4. Decisions & Constraints: your instructions, corrections and rules.
5. Files: changed, new and read files, with relative paths.
6. Lessons: notes that the agent wrote, such as memory notes and diagnoses.
7. Project Knowledge: project notes, repeated build and test commands, hosts.
8. Commits: hash and subject.
9. Open Errors: recent failures with no later success.
10. Recent Transcript: a ranked part of the recent work.

## Settings

Namespace `compactor`. Open it with `/unipi:settings`.

| Key | Default | What it does |
|---|---|---|
| `method` | `vcc` | `vcc` is lossless. `llm` is the model summary. |
| `piCompact` | `follow` | Sets what Pi's `/compact` does. `follow` uses `method`. |
| `trigger` | `pi` | `pi` uses Pi's context limit. `percent` compacts at `thresholdPercent`. |
| `thresholdPercent` | `80` | Context percent for the `percent` trigger. Range 30 to 95. |
| `notify` | `true` | Shows the card after an automatic compaction. Failures always show. |
| `smartKeepTail` | `true` | Keeps more recent turns when the kept tail is very small. |
| `summaryBudgetTokens` | `0` | Lossless summary size. `0` is auto. |
| `sections.<name>` | `true` | Turns one summary section on or off. |
| `cooldownMs` | `60000` | Minimum time between two `percent` compactions. |
| `repeatMinGrowthTokens` | `4000` | New tokens needed before the next `percent` compaction. |
| `llmInstructions` | empty | More instructions for the model summary. |
| `debug` | `false` | Writes diagnostics to `/tmp/compactor-debug.json`. |

The `percent` trigger compacts at a turn boundary. Goal, ralph and kanboard
loops continue without a stop.

## For other modules

Register an active work provider. The summary then starts with your state.

```ts
import { registerCompactionContext } from "@pi-unipi/core";
registerCompactionContext("my-module", () => (running ? "Task X is in progress" : null));
```

A turn-boundary compaction does not fire Pi's `session_compact` event. Listen to
`UNIPI_EVENTS.COMPACTOR_COMPACTED` to get each compaction.

## How it works

Read [Compaction](../../docs/architecture/compaction.md) and
[Prefix cache](../../docs/architecture/prefix-cache.md).

## See also

- [Commands reference](../../docs/reference/commands.md)
- [Settings reference](../../docs/reference/settings.md)
- [Memory](../memory/README.md)
