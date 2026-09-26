# @pi-unipi/subagents

Devin-model subagents for pi: the lead delegates self-contained work to independent child
agents (`pi --mode rpc`) that run alongside it.

- `run_subagent` — foreground (wait + report) or background (`<subagent_completion_notification>`
  followUp, exactly once). Approval prompts reach the user only while a foreground waiter is
  attached; background subagents are auto-denied. `resume:<agent_id>` continues an earlier agent
  in its session file. Max 8 concurrent.
- `read_subagent` — shared tool (core registry): reads subagents AND Fusion sidekick handoffs.
- Profiles: `subagent_explore` (read-only allowlist + cheap default model),
  `subagent_general` (all tools minus nesting, parent's model), and custom markdown agents from
  `~/.unipi/config/agents/` + `<workspace>/.unipi/config/agents/` (project wins).
- Nesting: children spawn only below `UNIPI_SUBAGENT_MAX_DEPTH` (default 1 = no nesting).
- Badge naming: `BADGE_GENERATE_REQUEST` runs an in-process one-shot (no child pi).
- Persisted run index at `<sessionDir>/index.json` powers CP4's panel/footer.
