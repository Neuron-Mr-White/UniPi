# @pi-unipi/subagents

Devin-model subagents for pi: the lead delegates self-contained work to independent child
agents (`pi --mode rpc`) that run alongside it.

- `run_subagent` — foreground (wait + report) or background (`<subagent_completion_notification>`
  followUp, exactly once). Approval prompts reach the user only while a foreground waiter is
  attached; background subagents are denied with a reason ("running in the background… don't
  retry"). `resume:<agent_id>` continues an earlier agent in its session file.
- `read_subagent` — shared tool (core registry): reads subagents AND Fusion sidekick handoffs.
- Profiles: `subagent_explore` (read-only allowlist + cheap default model),
  `subagent_general` (all tools minus nesting, parent's model), and custom markdown agents from
  `~/.unipi/config/agents/` + `<workspace>/.unipi/config/agents/` (project wins).
- Nesting: children spawn only below `UNIPI_SUBAGENT_MAX_DEPTH` (default 1 = no nesting).

## Screen

| Where | What |
|---|---|
| Chat | `● Explore subagent <title>` card — live tail + `ctrl+b background · esc cancel` while it runs, then `└ Completed · 7s · 1 tool call` (ctrl+o shows the report). Background finishes: `● Subagent "<title>" completed └ …`. |
| Below the input | `N subagents (k running) · ↓ select` — stays for the session, survives restart + resume. |
| Dock (↓ from an empty input, or `/unipi:subagents`) | `↑↓` navigate · `↵` view the live transcript · `f` foreground · `x` cancel · `esc` close. |
| Transcript view | task, tool calls with output, text; `↑↓`/PgUp/PgDn scroll, `g`/`G` top/end, `o` full tool output. |
| Foreground | Spinner reads `Subagent running · Ctrl+B to run in background`. **Ctrl+B** sends every foreground subagent to the background; **Esc** cancels a foreground run. `f` on a background agent shows its live steps above the input and routes its approvals to you. |

States: running `◐`, completed `✓`, failed `✗`, cancelled `⊘` (its own state — "cancelled by you"
when you pressed Esc or `x`).

## Config

`/unipi:settings → Subagents`: enabled, default subagent model (picker; empty = Fusion sidekick →
your model), default thinking, max running at once, **Manage agents…**. Settings and agent files
are re-read every turn — no restart.

`/unipi:agents` — list profiles; create a custom agent step by step (name → this project / all
projects → description → model → tools → prompt); edit, copy between global/project, or delete.
Files use the Devin/Claude format (`name`, `description`, `model`, `allowed-tools`|`tools`,
`thinking`, `max-nesting`; body = system prompt).

State: `~/.unipi/workspace/<id>/state/subagents/sessions/<lead-session-id>/` (`index.json` + one
`<agent_id>.jsonl` child session per agent).
