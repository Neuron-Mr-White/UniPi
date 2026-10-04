---
name: utility
scope: agent
description: |
  What the @pi-unipi/utility extension does for the user: the /unipi:settings
  hub, /unipi:continue (/unipi:retry), /unipi:cleanup, /unipi:doctor,
  /unipi:summarize, and automatic session naming. It gives the agent no tools.
---

# @pi-unipi/utility

## Commands (user-facing)

| Command | Purpose |
|---------|---------|
| `/unipi:settings` | Configure every UniPi module |
| `/unipi:continue` / `/unipi:retry` | Take another turn without new text |
| `/unipi:cleanup` | Remove stale UniPi temp files (previews and asks first; `--dry-run`, `--yes`) |
| `/unipi:doctor` | Check config, model cache, Decision Model key, skill exposure |
| `/unipi:summarize [focus]` | Summarize the last reply again (runs the `summarize` skill); any text is passed to the skill as the user's question |

## Notes for the agent

- There is no tool to rename the session. Naming happens automatically after
  real requests; the user can also use pi's `/name`.
- Skills not listed in your catalog may still be installed. If the user names
  a skill, read its SKILL.md or ask them to run `/skill:<name>`.
- When something UniPi-related looks broken, suggest `/unipi:doctor`.
