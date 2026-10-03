# Skill Registry

Skill Registry controls which skills the agent sees, per project, and keeps the system prompt stable for the prefix cache.

`@pi-unipi/skill-registry` · part of [UniPi](../../README.md)

## What it does

- Turns each skill on or off, in the global scope or the project scope.
- Marks a skill as "must show", so the agent always sees it.
- Keeps a vault of extra skills in `~/.unipi/skill-vault/`. Vault skills stay off until a scope turns them on.
- When you have many skills, lists only the skills that matter to the first real request.
- Names each hidden skill in a short system prompt section, so the agent can read it when necessary.
- Keeps the listed set the same for all of the session, so the prefix cache stays valid.

## Quick start

Skill Registry ships in `@pi-unipi/unipi`. To install it alone:

```bash
pi install npm:@pi-unipi/skill-registry
```

1. Type `/unipi:skills`. The settings hub opens on the Skills group.
2. Set **Skill proxy** to on. Without the proxy, Skill Registry saves your per-skill choices but does not apply them.
3. Select **Skill settings…** to open the skill grid.
4. Set the cells, then press `Enter` to save.

Changes apply from the next prompt. You do not need `/reload`.

## Commands

| Command | What it does |
|---|---|
| `/unipi:skills` | Opens `/unipi:settings` on the Skills group. |

## Skill grid

**Skill settings…** shows each skill with its source (`vault`, `project`, `user`, `unipi` or `package`) and two columns:

- **E** (enabled): the agent can see the skill. Off removes it from the session, and blocks `/skill:name`.
- **M** (must show): the agent always sees the skill, also when exposure judging would hide it.

| Key | What it does |
|---|---|
| `↑` `↓`, PgUp, PgDn | Moves between skills. |
| `←` `→`, Tab | Moves between the E and M columns. |
| Space | Toggles the cell. |
| `d` | Clears the cell in the current scope. The cell then inherits again. |
| `g` | Changes the scope: global or project. |
| `p` | Turns the skill proxy on or off. |
| Other letters | Filter by name, source or description. Esc clears the filter. |
| `Enter` | Saves. |
| `Esc` | Cancels. |

A project value wins over a global value. With no value, vault skills are off and all other skills are on. Skill Registry writes only the cells that you change.

## Settings

Open `/unipi:settings` → Skills. The namespace is `skills`.

| Key | Default | What it does |
|---|---|---|
| `proxy` | `false` | Applies the per-skill states and includes the vault. |
| `exposure.mode` | `judged` | `judged`: jev picks the listed skills. `all`: list all skills. `off`: remove the UniPi bundled skills from the list. |
| `exposure.threshold` | `0.8` | Minimum jev relevance score for a skill to stay listed. Range 0 to 1. |
| `exposure.maxSkills` | `12` | Maximum number of listed skills. With this number of skills or fewer, no judging occurs. |
| `exposure.recheck` | `true` | On later prompts, tells the agent about hidden skills that jev finds relevant. |
| `states` | `{}` | Per-skill `enabled` and `mustShow`. Edit it in **Skill settings…**. |

The group also has a Decision model section. Set `decisionModel.source` to `inherit` or `custom`.

Set `UNIPI_SKILL_VAULT` to use a different vault folder.

## How it works

In `judged` mode, Skill Registry picks the listed set on the first real prompt of the session. Greetings do not count. jev is the UniPi Decision Model.

1. A skill that the prompt names is always kept. A distinctive word of the name is enough: "ssh into coffee" keeps `coffee-sandbox`.
2. Must-show skills are always kept.
3. jev scores the other skills against the prompt. Skills at or above `exposure.threshold` stay, best first, up to `exposure.maxSkills`.
4. A system prompt section names each hidden skill and its folder.

After this, the system prompt does not change for the session. On a later prompt, a message tells the agent about hidden skills that the prompt names. With `exposure.recheck`, it also tells the agent about hidden skills that jev finds relevant. Each message names 5 skills at most.

If jev does not answer, Skill Registry lists all skills.

The vault holds any folder with a `SKILL.md`, up to three levels deep: `vault/<skill>/` or `vault/<pack>/<skill>/`.

Other packages can emit the `unipi:skills:reveal` event with `{ names: [...] }` to tell the agent about hidden skills.

## See also

- [Prefix cache](../../docs/architecture/prefix-cache.md)
- [Settings reference](../../docs/reference/settings.md)
- [Glossary](../../docs/reference/glossary.md)
