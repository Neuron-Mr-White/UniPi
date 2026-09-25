# @pi-unipi/long-horizon

Long-horizon execution for Pi/UniPi. A small **jev** judge (TypeSafe System One)
picks the cheapest mode that can finish a task — `direct`, `plan`, or `goal` —
and the engine keeps goal-mode runs honest across many turns.

- **Mode gating:** ambiguous work is judged before the runner starts, so simple
  edits stay direct and real multi-step work gets a plan or a goal.
- **Goal mode:** an owned goal-state file, continuation prompts, and a loop that
  stops when the goal is met — no drifting forever.
- **Orchestration:** `/ralph` loops, `/swarm` parallel lanes, and `/graph`
  dependency graphs over tasks.
- **Judge:** provider-agnostic decision calls (OpenRouter by default) with the
  key resolved from settings or the environment.

See `skills/` for the agent-facing command docs.
