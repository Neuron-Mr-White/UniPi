# @pi-unipi/utility

The settings hub, automatic session naming, and a few maintenance commands. Also keeps the shared model cache every other module's model picker reads.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:settings` | Configure every UniPi module in one panel (global + project scopes) |
| `/unipi:continue` (`/unipi:retry`) | Take another turn from where the agent stopped, without adding text |
| `/unipi:cleanup` | Remove stale UniPi temp files and leftovers. Shows what it would remove and asks first; `--dry-run` only lists, `--yes` skips the question |
| `/unipi:doctor` | Check folders, config, the model cache, the Decision Model key and skill exposure |

Skill exposure and the skill manager live in `@pi-unipi/skill-registry` (`/unipi:skills`).

The main agent gets no tools from this package.

## Automatic session naming

After each round that finished normally, if you typed the prompt:

1. Greetings, thanks, "ok", "continue" and slash commands are skipped outright.
2. jev (the Decision Model) answers two short questions: is this a real request with its own subject, and — if the session already has a name — does it move to a different task? Only a confident "yes" renames.
3. The name is written by a separate throwaway session whose only tool is `rename_session`. It sees the current name and your last few requests, nothing else, and never touches the main session.

A name you set yourself with pi's `/name` is never overwritten. Without a Decision Model key, only an unnamed session gets named, on its first prompt of four words or more.

Inside Herdr, the name is also shown as the pane title and, while the tab still has its default number, the tab label.

Settings (`/unipi:settings` → Utility → Session name): auto-rename on/off, naming model (defaults to the session model), Herdr sync, and a **Rename now** action.

## Model cache

On every session start, utility writes pi's live model list (models with credentials) to `~/.unipi/config/models-cache.json`, with each model's input and output modalities. The settings hub pickers and kanboard read it; `readModelCache()` / `filterModels()` in `@pi-unipi/core` give the same list to any module.

## Cleanup safety

`/unipi:cleanup` can only remove what its allowlist names: saved tool outputs and `unipi-*` temp files older than 7 days, and the old compactor continuity database. Memory, v2 backups, kanboard boards, config and workspace state are never candidates.

## License

MIT
