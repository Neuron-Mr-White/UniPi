---
name: subagents
description: Delegating work to independent subagents (run_subagent/read_subagent).
---

# Subagents

`/unipi:` has no subagent commands — the model drives delegation through tools.

- `run_subagent({title, task, profile, is_background?, resume?})` launches an independent agent
  with its own context. It does not see this conversation — put everything it needs in `task`.
- `read_subagent({agent_id?, block?, timeout?})` reads/waits on a subagent (or a Fusion
  sidekick handoff) by id.

Profiles:
- `subagent_explore` — read-only (read/grep/find/ls/web_search/memory_search/memory_list), cheaper default model.
- `subagent_general` — all tools except nesting tools, runs on your model.
- Custom `.md` agents under `~/.unipi/config/agents/` (global) or
  `<workspace>/.unipi/config/agents/` (project), YAML frontmatter:
  `name, description, model, tools|allowed-tools, thinking, max-nesting`; body = system prompt.

Rules: parallelize independent work; foreground waits for the report; background can't ask
for approval (auto-denied); resume a finished/failed/cancelled agent with `resume:<agent_id>`.
