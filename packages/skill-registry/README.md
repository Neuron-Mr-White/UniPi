# @pi-unipi/skill-registry

Decides which skills the agent sees: per-project on/off, a vault of extra skills, and jev-judged exposure. Also ships UniPi's general workflow skills (`brainstorm`, `plan`, `work`, `debug`, …) under `skills/`.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:skills` | The skill manager (also `/unipi:settings` → Skills → Manage skills…) |

## The skill manager

One row per skill, grouped by where it lives: vault, project, user, UniPi, packages. Each row shows what applies and which layer set it:

```
● coffee-sandbox        on · listed     g:–  p:on
◐ ponytail-audit        on · unlisted   g:on/unl  p:–
○ aws-deploy            off             g:–  p:–
```

| Key | Action |
|-----|--------|
| `space` | Turn the skill on/off at the scope you're editing |
| `d` | Listed ↔ unlisted (unlisted skills still work with `/skill:name`) |
| `g` | Switch the edited scope: project ↔ global |
| `p` | Turn the skill proxy on/off |
| `enter` | Show the description and path |
| `/` | Search |

Both toggles cycle the edited layer: *unset → set → opposite → unset*, so a project can override the global choice or go back to inheriting it.

## Skill proxy

Off by default. While off, pi's skills pass through untouched (exposure judging still applies), vault skills stay hidden, and your choices are saved but not applied. Turn it on and:

- Skills turned **off** are removed from the session, including `/skill:name`.
- **Unlisted** skills are left out of the system prompt but still run with `/skill:name`.
- The **vault**, `~/.unipi/skill-vault/`, takes part. Keep as many skills there as you like; they stay off until a scope turns them on, so a project only gets the ones it needs. Changes apply on the next prompt, no reload needed. Any folder with a `SKILL.md`, up to three levels deep (`vault/<skill>/` or `vault/<pack>/<skill>/`).

## Exposure

Settings → Skills → Exposure:

- **judged** (default) — when more skills are available than *Max skills listed* (12), the first real request of the session picks the listed set, and it stays fixed for the session so the system prompt never changes (prefix cache intact). Greetings don't count.
  1. **Named skills are always kept.** A skill whose name appears in the request (`agent-browser`, "grill me") or a word only its name contains ("ssh into **coffee**" → `coffee-sandbox`) is listed without asking a model.
  2. **jev scores the rest** against the request; those above the threshold are listed best first, with at most four of the general workflow skills so they can't crowd out specific ones.
  3. **Hidden skills are still named.** The system prompt gets a short section listing every hidden skill by folder, so the agent knows it exists and can read its `SKILL.md`.
  4. **Later requests** that name a hidden skill (or, with *recheck*, that jev finds it relevant to) get a message pointing at it. The system prompt itself never changes.
- **all** — every skill is listed.
- **off** — UniPi's bundled skills are removed from the list.

jev uses the shared Decision Model (Settings → Skills → Decision model: inherit or custom). If jev is unavailable, every skill is listed.

## License

MIT
