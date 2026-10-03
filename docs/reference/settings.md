# Settings

This page tells you where UniPi keeps its settings and how to change them. It
also lists the settings of each module. The list comes from the
`registerSettings` calls in the source.

Terms such as jev, Decision Model and sidekick are in the
[glossary](glossary.md).

## How settings work

Each UniPi module registers one settings **namespace**. UniPi reads a setting
from three layers:

1. The default value in the code.
2. The global file `~/.unipi/config/<namespace>/config.json`.
3. The project file `<project>/.unipi/config/<namespace>/config.json`.

A later layer wins over an earlier layer. Thus a project value wins over a
global value.

UniPi writes the migration ledger to `~/.unipi/config/settings-version.json`.
It copies old settings files into the new layout one time. It keeps backups in
`~/.unipi/config/.backup/`.

### The settings hub

Use the settings hub to change settings. Do not edit the files by hand.

1. Type `/unipi:settings` to open the hub.
2. Type `/unipi:settings <search>` to open the hub with a filter.
3. Push `g` to toggle the write scope between global and project.
4. Select a row and push `Enter`.

The hub opens in the global scope. The frame title shows the current scope. In
the project scope, a list may have a `use default` value. This value deletes the
project key, so the global value applies again. For all hub keys, see
[shortcuts.md](shortcuts.md#keys-in-the-settings-hub).

Some rows are actions. An action row runs a flow, for example "Send test
notification". Some groups collapse rare rows under "Advanced".

### Data that is not a setting

Some data has its own files and its own editor:

- MCP servers. Edit them from the hub rows under MCP.
- Fusion presets (the lead and sidekick lists). Edit them with "Edit fusion
  presets…" under Fusion.
- Custom subagent profiles. Edit them with `/unipi:agents`.
- Permission rules that you saved from an approval prompt.

### The Decision Model

Several modules ask jev, a decision model, for a judgment. The "Decision Model"
group holds the shared jev settings. The Long-Horizon, Permissions, Skills,
Utility and Watchdog groups each have an "Advanced" Decision Model section. Set
`decisionModel.source` to `inherit` to use the shared settings. Set it to
`custom` to use the fields of that section.

## Settings by namespace

The tables use the key names of the settings files. The hub shows a label for
each key. A dash (—) in the Default column means that the value is empty or
comes from the code.

### ask-user (hub: Ask User)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `enabled` | on, off | off | Lets the agent use `ask_user`. |
| `notifyOnAsk` | on, off | on | Sends a notification when the agent waits for your answer. |
| `maxQuestions` | 1–4 | 4 | Sets the maximum questions in one dialog. |
| `escape` | `stop`, `send` | `stop` | Sets what `Esc` does in the dialog. |
| `digitAdvance` | on, off | on | A digit key picks an option and goes to the next question. |
| `other` | `agent`, `always`, `never` | `agent` | Controls the free-text "Other" row. |
| `helpLine` | on, off | on | Shows the "Not ready to answer" line under the dialog. |

### background-tasks (hub: Background Tasks)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `enabled` | on, off | on | Off means that the module registers no tools, commands or keys. |
| `notifyOnCompletion` | on, off | on | Sends a notice when a task finishes. |
| `triggerOnCompletion` | on, off | on | A finished task wakes the agent. |
| `defaultTimeoutSeconds` | number | 0 | Sets the default task timeout. |
| `maxFinishedTasks` | number | 30 | Sets how many finished tasks UniPi keeps. |
| `maxOutputBytes` | number | 20 MiB | Stops and fails a task above this output size. |

### command-enchantment (hub: Command Enchantment)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `autocompleteEnhanced` | on, off | on | Gives fuzzy suggestions for `/unipi:*` commands. |

### compactor (hub: Compactor)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `method` | `vcc`, `llm` | `vcc` | `vcc` writes a lossless summary with no model call. `llm` asks a model for the summary. |
| `piCompact` | `follow`, `vcc`, `llm` | `follow` | Sets what the Pi `/compact` command does. `follow` uses `method`. |
| `trigger` | `pi`, `percent` | `pi` | `pi` compacts at the Pi context limit. `percent` compacts at `thresholdPercent`. |
| `thresholdPercent` | number | 80 | Sets the trigger percentage of the context window. |
| `notify` | on, off | on | Shows a notice when compaction runs or fails. |
| `smartKeepTail` | on, off | on | Keeps more recent turns when the kept tail is very small. |
| `summaryBudgetTokens` | number | 0 (auto) | Sets the size of the lossless summary in tokens. |
| `sections.*` | on, off | on | Turns each summary section on or off. |
| `cooldownMs` | number | 60000 | Sets the minimum time between two percentage compactions. |
| `repeatMinGrowthTokens` | number | 4000 | Sets the new tokens that a second percentage compaction needs. |
| `llmInstructions` | text | — | Adds instructions to model-written summaries. |
| `debug` | on, off | off | Writes diagnostics to `/tmp/compactor-debug.json`. |

The `sections.*` keys are `activeWork`, `requests`, `state`, `decisions`,
`files`, `commits`, `errors`, `lessons` and `transcript`.

### decision-model (hub: Decision Model)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `provider` | `openrouter`, `typesafe`, `custom` | `openrouter` | Sets where UniPi sends jev questions. |
| `model` | model ID | `typesafe/jev-1.13` | Sets the decision model. |
| `baseUrl` | URL | — | Sets the endpoint. The `custom` provider needs it. |
| `apiKey` | secret | — | A stored key wins over `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY`. |
| `timeoutMs` | number | 0 (auto) | Sets the request timeout. |

### footer (hub: Footer)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `enabled` | on, off | on | Turns the footer on or off. |
| `preset` | `default`, `classic`, `minimal`, `dense`, `devops`, `zen` | `default` | Sets the segment layout. |
| `glanceMode` | on, off | on | Turns the glance footer on. |
| `showFullLabels` | on, off | off | Shows labels instead of compact segments. |
| `separator` | `powerline`, `powerline-thin`, `slash`, `pipe`, `dot`, `ascii` | `powerline-thin` | Sets the segment divider. |
| `zoneSeparator` | `│`, `╎`, `·`, `─`, `none` | `│` | Sets the divider between the footer zones. |
| `iconStyle` | `emoji`, `nerd`, `text` | `nerd` | Sets the icon style. |
| `colorMode` | `auto`, `truecolor`, `256`, `mono` | `auto` | Sets the color depth. |
| `groups.<group>.show` | on, off | on | Shows or hides a segment group. The `notify` group is off by default. |

The "Segments…" page also has one switch for each segment.

### fusion (hub: Fusion)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `startup.model` | model | — | Sets the model that Pi starts with. Global scope only. |
| `startup.thinking` | `off` to `xhigh` | — | Sets the thinking level that Pi starts with. Global scope only. |
| `default.lead` | model | — | Sets the default lead of a Fusion pair. |
| `default.sidekick` | model | — | Sets the default sidekick of a Fusion pair. |

### hints (hub: Hints)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `enabled` | on, off | on | Shows one-line Unicrab hints above the editor. |
| `header` | on, off | on | Shows the Unicrab start screen. |
| `crab` | `auto`, `blocks`, `image` | `auto` | Sets how the mascot draws. `image` uses Kitty graphics. |

### image (hub: Image)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `generate.enabled` | on, off | on | Gives the agent `image_generate`. |
| `generate.model` | model | `openrouter/black-forest-labs/flux.2-klein-4b` | Sets the image model. |
| `generate.outputDir` | path | `~/.unipi/images` | Sets the folder for saved images. |
| `generate.saveToDisk` | on, off | on | Saves each image to the folder. |
| `edit.enabled` | on, off | on | Gives the agent `image_edit`. |
| `edit.model` | model | `openrouter/black-forest-labs/flux.2-klein-4b` | Sets the edit model. |
| `recognize.enabled` | on, off | on | Gives text-only models `image_recognize`. |
| `recognize.model` | model | — | Sets the vision model. |
| `recognize.systemPrompt` | text | built-in prompt | Sets the system prompt of the vision call. |
| `keys.openrouter`, `keys.fal` | secret | — | Sets the provider keys. |

Each of `generate`, `edit` and `recognize` also has `baseUrl` and `apiKey`
for a custom endpoint. `generate` and `edit` also have `api`.

### info-screen (hub: Info Screen)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `bootMode` | `on`, `off`, `auto-close` | `auto-close` | Sets what the dashboard does at startup. |
| `bootTimeoutMs` | number | 2000 | Sets the time before `auto-close` closes the dashboard. |
| `groupOrder` | list | — | Sets the tab order of the dashboard groups. |

The "Groups & stats…" page has one switch for each group and each stat.

### input-shortcuts (hub: Input Shortcuts)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `chordKey` | key ID | `alt+s` | Shows in the info screen. See the note below. |
| `tabInsertKey` | key ID | `alt+i` | Shows in the info screen. See the note below. |

In this release, the code registers `Alt+S` and `Alt+I` directly. A changed
value does not change the keys.

### kanboard (hub: Kanboard)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `chainGate` | `in_review`, `done` | `in_review` | Sets when a dependency counts as satisfied for the next task. |
| `idleMin` | minutes | 10 | Stops the daemon after this idle time. |
| `host` | address | `127.0.0.1` | Sets the bind address. A non-loopback address needs the access token. |
| `port` | number | 0 (auto) | Sets the daemon port. |
| `archiveAfterDays` | days | 0 (off) | Archives done and cancelled tasks at session start. |
| `retentionDays` | days | 90 | Moves archived tasks to cold storage. |
| `openBrowser` | on, off | off | Opens the board in a browser on `/unipi:kanboard open`. |
| `requireAuth` | on, off | off | Asks for the access token on localhost too. |
| `keepToken` | on, off | off | Keeps one access token across daemon restarts. |
| `maxSessions` | number | 2 | Sets how many sessions can hold tasks at one time. |
| `turnAddLimit` | number | 20 | Sets how many tasks the agent can add in one turn. 0 means no limit. |
| `reminders` | on, off | on | Reminds the agent to start a Todo task before it edits files. |
| `doTasks` | number | 5 | Sets the task slots that `/unipi:kanboard-do` gives. |
| `doWrites` | number | 10 | Sets the board writes that `/unipi:kanboard-do` gives. |

### long-horizon (hub: Long-Horizon)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `judge.enabled` | on, off | off | Lets jev select the mode for each new prompt. |
| `judge.threshold` | 0.01–1 | 0.8 | Below this confidence, the judge gives no mode. |
| `defaultMode` | `goal`, `ralph`, `swarm`, `graph`, `none` | `none` | Sets the mode when the judge is off or gives no mode. |
| `verifierModel` | model | — (session model) | Sets the model that checks goal completion. |
| `goalProgress` | `loop`, `status`, `off` | `loop` | Sets when UniPi estimates the goal progress. |
| `progressModel` | model | — | Sets the model for the progress estimate. |

### mcp (hub: MCP)

This group has only action rows: configure servers, add a server, sync the
catalog and reload servers. The server list is not a setting.

### memory (hub: Memory)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `recallAtStart` | on, off | on | Adds a memory reminder to the first turn. |
| `write` | on, off | on | Gives the agent `memory_store` and `memory_delete`. |
| `wakeUp` | on, off | on | Adds the MemPalace wake-up summary to the start reminder. |
| `saveMode` | `side`, `reminder`, `off` | `side` | Sets how UniPi saves memories at the end of a task. |
| `autoStartDaemon` | on, off | off | Starts a MemPalace daemon for Pi. |
| `mempalaceAutoUpdate` | on, off | on | Checks PyPI each day and upgrades MemPalace. |

`saveMode` values:

- `side`: a background side session reads the run and stores the useful facts.
- `reminder`: a note at the end of the task asks the agent to save.
- `off`: no save pass.

### notify (hub: Notify)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `defaultPlatforms` | `native`, `gotify`, `telegram`, `ntfy` | `native` | Sets the platforms for events with no platform list. |
| `events.<event>.enabled` | on, off | varies | Turns one event on or off. |
| `events.<event>.platforms` | platforms | default platforms | Sets the platforms of one event. |
| `native.enabled` | on, off | on | Turns OS notifications on. |
| `native.suppressWhenFocused` | on, off | off | Skips OS notifications while the terminal has focus. |
| `recap.enabled` | on, off | off | Turns session recap digests on. |
| `recap.model` | model | `openrouter/openai/gpt-oss-20b` | Sets the recap model. |
| `silenceAfterInput.enabled` | on, off | off | Holds notifications while you type. |
| `silenceAfterInput.windowMs` | number | 10000 | Sets the silence window. |
| `renotify.enabled` | on, off | on | Repeats a notification that you did not answer. |
| `renotify.intervalMs` | number | 120000 | Sets the time between repeats. |
| `renotify.maxRepeats` | number | 3 | Sets the maximum repeats. |

The events are `workflow_end`, `ralph_loop_end`, `mcp_server_error`,
`agent_end`, `agent_settled`, `memory_consolidated`, `session_shutdown`,
`ask_user_prompt` and `permission_request`. The first three events are on by
default.

The `gotify`, `telegram` and `ntfy` pages hold the server URL, the tokens and
the priority of each platform.

### permission (hub: Permissions)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `mode` | `ask`, `auto`, `full` | `auto` | Sets the mode of this project. Project scope only. `Alt+M` cycles it. |
| `defaultMode` | `ask`, `auto`, `full` | `auto` | Sets the mode for projects that set no mode. |
| `jevJudge` | on, off | on | In `auto` mode, asks jev about an unknown `bash` command. |
| `jevConfidence` | number | 0.7 | Below this confidence, a "safe" verdict still asks you. |

### skills (hub: Skills)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `proxy` | on, off | off | Applies the choices for each skill. It also adds `~/.unipi/skill-vault`. |
| `exposure.mode` | `judged`, `all`, `off` | `judged` | Sets which skills the system prompt lists. `judged` lets jev select them. |
| `exposure.threshold` | 0–1 | 0.8 | Sets the minimum jev relevance for a listed skill. |
| `exposure.maxSkills` | number | 12 | Sets the maximum listed skills. |
| `exposure.recheck` | on, off | on | Tells the agent about skills that become relevant later. |

The "Skill settings…" row sets Enabled and Must show for each skill.

### subagents (hub: Subagents)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `enabled` | on, off | on | Gives the agent `run_subagent` and `read_subagent`. |
| `defaultModel` | model | — (auto) | Sets the model of `subagent_explore` and of custom agents with no model. |
| `defaultThinking` | `inherit`, `off` to `xhigh` | `inherit` | Sets their thinking level. |
| `maxConcurrent` | 1–16 | 8 | Sets how many subagents can run at one time. |

With an empty `defaultModel`, UniPi uses the Fusion sidekick model, or else your
model. `subagent_general` always uses your model.

### updater (hub: Updater)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `checkIntervalMs` | 30 min, 1 hour, 6 hours, daily | 1 hour | Sets how often UniPi checks npm for updates. |
| `autoUpdate` | `disabled`, `notify`, `auto` | `notify` | Sets what UniPi does when an update exists. |

### utility (hub: Utility)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `rename.auto` | on, off | on | Names the session when a real request starts or the topic changes. |
| `rename.model` | model | — | Sets the naming model. |
| `rename.herdrSync` | on, off | on | Shows the session name as the Herdr pane title. |
| `answer.method` | `reply`, `questions`, `web` | `reply` | Sets the default screen of `/unipi:answer`. |
| `answer.hint` | on, off | on | Shows a hint after a reply that asks questions. |
| `answer.port` | number | 0 (auto) | Sets the port of the web form. |
| `render.style` | `simple`, `regular`, `advanced` | `regular` | Sets how tool calls show in the transcript. |
| `attachments.enabled` | on, off | on | Changes pasted file paths into `[Image #N]` and `[File #N]` tokens. |
| `attachments.preview` | on, off | on | Shows small image previews in supported terminals. |

### watchdog (hub: Watchdog)

The watchdog asks jev about long-running tool calls. It can kill a stuck call
or warn you.

| Key | Values | Default | What it changes |
|---|---|---|---|
| `enabled` | on, off | off | Turns the watchdog on. |
| `intervalMin` | minutes | 5 | Sets the time between checks. |
| `firstCheckMin` | minutes | 2 | Sets the time before the first check. |
| `confidence` | number | 0.8 | Sets the minimum jev confidence to act. |
| `agreeChecks` | number | 2 | Sets how many checks in a row must agree. |
| `action` | `kill`, `warn` | `kill` | Sets what the watchdog does. |
| `watchBash` | on, off | on | Watches `bash` calls. |
| `watchBgTasks` | on, off | on | Watches background tasks. |
| `otherTools` | `off`, `warn`, `abort-turn` | `warn` | Sets what happens for tools with no kill handle. |

### web-api (hub: Web API)

| Key | Values | Default | What it changes |
|---|---|---|---|
| `providers.<id>.enabled` | on, off | varies | Turns one search or read provider on or off. |
| `providers.<id>.apiKey` | secret | — | Sets the API key of a paid provider. |
| `smartFetch.browser` | browser profile | — | Sets the TLS fingerprint profile. |
| `smartFetch.os` | `windows`, `macos`, `linux` | — | Sets the OS fingerprint. |
| `smartFetch.includeReplies` | `true`, `false`, `extractors` | `extractors` | Sets if UniPi reads comments and replies. |
| `smartFetch.maxChars` | number | — | Sets the maximum characters of a page. |
| `smartFetch.timeoutMs` | number | — | Sets the request timeout. |
| `smartFetch.batchConcurrency` | 1–32 | — | Sets how many URLs UniPi reads at one time. |
| `smartFetch.removeImages` | on, off | — | Drops images from the page text. |

The providers on by default are `wigolo`, `duckduckgo`, `jina-search`,
`jina-reader` and `llm-summarize`. The providers off by default are `serpapi`,
`tavily`, `firecrawl` and `perplexity`.
