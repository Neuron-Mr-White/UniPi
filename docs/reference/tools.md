# Agent tools

This page lists every tool that UniPi gives to the agent (the model). The list
comes from the `pi.registerTool` calls in the source. You do not call these
tools yourself. The agent calls them.

Terms such as goal, ralph and sidekick are in the [glossary](glossary.md).

## How to read this page

- **Key parameters** names the main inputs. Optional inputs have a `?`.
- **When available** tells you when the agent can see the tool. "Always" means
  that the tool is in the tool list when its package loads.
- Some packages register no tools. The kanboard agent uses the `kanboard` CLI
  through `bash` and the `kanboard` skill.

## [ask-user](../../packages/ask-user/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `ask_user` | Asks you 1 to 4 multiple-choice questions in one dialog. It waits for the answers. | `questions[]`: `question`, `header`, `options[]`, `multi_select?`, `other?` |

When available: always. The tool returns a refusal when the `ask-user` setting
`enabled` is off. This setting is off by default. A subagent cannot use the tool.

## [background-tasks](../../packages/background-tasks/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `bg_run` | Starts a named shell command in the background. It returns a task ID at once. | `name`, `command`, `isAgent`, `timeoutSeconds?`, `notifyOnCompletion?`, `triggerOnCompletion?` |
| `bg_status` | Shows one task, or lists all running and recent tasks. | `taskId?` |
| `bg_logs` | Reads a bounded part of the task output. | `taskId`, `maxBytes?`, `tail?` |
| `bg_kill` | Stops a running task. | `taskId` |

When available: only when the `background-tasks` setting `enabled` is on.
By default, a finished task wakes the agent for a follow-up turn.

## [compactor](../../packages/compactor/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `session_recall` | Searches the history of this session, also the compacted parts. | `query?`, `expand?`, `page?`, `scope?` (`lineage` or `all`), `mode?` (`hybrid` or `touched`) |
| `context_budget` | Estimates how full the context window is. | none |

When available: always. `session_recall` searches only the current session.

## [core](../../packages/core/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `read_subagent` | Reads the result of a subagent or of the sidekick. It can wait for the result. | `agent_id?`, `block?`, `timeout?` (seconds, default 30, max 600) |

When available: while subagents are on, or while a Fusion pair is active.

## [fusion](../../packages/fusion/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `sidekick` | Gives work to the persistent sidekick of this session. | `message`, `block?` (default `true`) |

When available: only while a Fusion pair is active. Select a pair with
`/unipi:model`. With `block: false`, the tool returns at once. The report
comes later as a notification.

## [long-horizon](../../packages/long-horizon/README.md)

Each long-horizon mode shows only its own tools. In regular mode, the agent
sees none of these tools.

| Tool | Mode | What it does | Key parameters |
|---|---|---|---|
| `create_goal` | goal | Sets one goal for the session. | `objective`, `token_budget?` |
| `get_goal` | goal | Reads the goal state, budgets and progress. | none |
| `update_goal` | goal | Proposes the goal as complete or blocked, or changes the token budget. | `mode` (`status` or `token_budget`), `status?`, `summary?`, `token_budget?` |
| `ralph_done` | ralph | Ends the current iteration. It checks the task file. | none |
| `loop_status` | ralph | Reads the loop state and the task-file progress. | none |
| `swarm_report` | swarm | Records the outcome of one swarm item. | `item_id`, `status`, `summary?`, `dispatched?` |
| `swarm_status` | swarm | Shows the status of each swarm item. | none |
| `swarm_yield` | swarm | Ends the supervisor turn while items run. | none |
| `update_agent_graph` | graph | Declares the work graph one time. | `task`, `items[]`: `item_id`, `instruction`, `depends_on?` |
| `graph_output` | graph | Records the outcome of one graph item. | `item_id`, `status`, `summary?`, `dispatched?` |
| `view_agent_graph` | graph | Shows the waves, the item status and the open count. | none |
| `todowrite` | goal, ralph, swarm, graph | Replaces the visible task list of the session. | `todos[]`: `content`, `status`, `priority` |

An independent verifier checks a goal or a ralph loop before it completes.

## [memory](../../packages/memory/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `memory_store` | Stores or updates a memory for later sessions. | `title`, `content`, `tags?`, `type?` (`preference`, `decision`, `pattern`, `summary`) |
| `memory_search` | Searches memories by keyword. | `query`, `limit?`, `scope?` (`all` or `project`) |
| `global_memory_search` | Same as `memory_search` with `scope: all`. | `query`, `limit?` |
| `memory_delete` | Deletes a memory of the current project. | `title?` or `id?` |
| `memory_list` | Lists the memories of the current project. | none |
| `global_memory_list` | Lists the memories of all projects. | none |

When available: always. The agent does not see `memory_store` and
`memory_delete` when the `memory` setting `write` is off. The command
`/unipi:memory write off` also hides them for one session.

## [notify](../../packages/notify/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `notify_user` | Sends a notification to your notify platforms. | `message`, `title?`, `priority?` (`low`, `normal`, `high`), `platforms?` |

When available: always. Platforms are `native`, `gotify`, `telegram` and `ntfy`.

## [subagents](../../packages/subagents/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `run_subagent` | Starts an independent subagent for a task. The subagent does not see the conversation. | `title`, `task`, `profile`, `is_background?`, `resume?` |

When available: only when the `subagents` setting `enabled` is on. A subagent
cannot start a subagent of its own. The built-in profiles are
`subagent_explore` and `subagent_general`. Make custom profiles with
`/unipi:agents`.

## [utility](../../packages/utility/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `image_generate` | Makes an image from a text prompt. | `prompt`, `model?` |
| `image_edit` | Edits an image with a text instruction. | `prompt`, `image`, `model?` |
| `image_recognize` | Asks a vision model about an image. | `image`, `prompt?`, `model?` |

When available: each image tool needs its `image` setting `enabled` on.
`image_recognize` hides while the session model can read images. It comes back
when you select a text-only model.

The utility package also registers the Pi tools `read`, `bash`, `edit` and
`write` again. It changes only how they show in the transcript. Their
behavior stays the same.

## [workflow](../../packages/workflow/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `plan_submit` | Sends the plan file to you for approval. | none |

When available: always. The tool works only in plan mode.

## [web-api](../../packages/web-api/README.md)

| Tool | What it does | Key parameters |
|---|---|---|
| `web_search` | Searches the web. | `query`, `source?` |
| `multi_web_content_read` | Reads one or more URLs and returns markdown. | `url` (string or array), `source?`, `browser?`, `os?`, `format?` |
| `web_llm_summarize` | Reads a URL and gives a model summary of it. | `url`, `prompt?`, `source?` |

When available: always. With no `source`, the tool selects the lowest-cost
provider and goes to the next on failure.

## [mcp](../../packages/mcp/README.md)

The MCP package registers one tool for each tool of each running MCP server.
The tool name is `<server>__<tool>`.
