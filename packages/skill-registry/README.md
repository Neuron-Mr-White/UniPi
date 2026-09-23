# @pi-unipi/skill-registry

**Placeholder package.** It ships no extension code — only skills — and exists so the
bundled skill set keeps loading through the `@pi-unipi/unipi` umbrella manifest.

The twenty skills that used to live in `@pi-unipi/workflow` moved here when that
package was repurposed for **plan mode** and **permission modes**. They are plain
`SKILL.md` instruction files; the slash commands that used to dispatch them
(`/unipi:brainstorm`, `/unipi:work`, `/unipi:review-work`, `/unipi:auto`, …) were
removed — plan mode (`/unipi:plan`, `Alt+P`) and ordinary prompting replace them. Every skill is still
loadable by name via `/skill:<name>` or by reading its `SKILL.md`, and jev skill
judging still sees them.

## Roadmap

This package becomes the real skill registry: discovery, install/update of third-party
skill packs, and the metadata (capability tags, model hints) that jev skill judging and
the `/unipi:settings` hub will consume. Until then it is a mount point, deliberately
code-free.

## Layout

```
skills/<name>/SKILL.md   # one directory per skill
```
