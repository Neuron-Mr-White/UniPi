# Command Enchantment

Command Enchantment makes `/unipi:*` suggestions in the editor easy to scan, with package tags, colors and a stable order.

`@pi-unipi/command-enchantment` · part of [UniPi](../../README.md) · source folder `packages/autocomplete`

## What it does

- Adds a colored package tag, for example `[workflow]`, to each `/unipi:*` suggestion. The tag replaces the pi source tag.
- Sorts suggestions by match quality: exact, then prefix, then fuzzy.
- Puts `/unipi:settings` first when you type `/settings`.
- Hides `/skill:*` suggestions until you type `/skill:`.
- Keeps argument suggestions for `/unipi:*` commands, also when you press Tab after a space.

## Quick start

Command Enchantment ships in `@pi-unipi/unipi`. To install it alone:

```bash
pi install npm:@pi-unipi/command-enchantment
```

1. Type `/unipi:` in the editor.
2. Read the package tag next to each suggestion.
3. Type a short name, for example `/plan`. The exact match `/unipi:plan` comes first.

The package has no commands and no agent tools.

## Settings

Open `/unipi:settings` → Command Enchantment. The namespace is `command-enchantment`.

| Key | Default | What it does |
|---|---|---|
| `autocompleteEnhanced` | `true` | Turns the enhanced suggestions on or off. Applies at the next session start. |

With `false`, the package does not add its provider. Pi suggestions stay as they are.

## How it works

At session start, Command Enchantment wraps the pi autocomplete provider. It changes only text that starts with `/`. Other text goes to the pi provider without a change.

For a command name, it uses this order:

1. A UniPi command that replaces a pi command with the same name (`settings`).
2. An exact match of the full command.
3. An exact match of the short name after `unipi:`.
4. A prefix match.
5. A fuzzy match. A shorter name comes first.

In the same tier, pi commands come before UniPi commands. UniPi commands then follow a fixed package order.

The command list is in `src/constants.ts`. An audit test checks that each registered `/unipi:*` command is in this list and has a description. Run it before a release:

```bash
npm --workspace packages/autocomplete test
```

## See also

- [Commands reference](../../docs/reference/commands.md)
- [Settings reference](../../docs/reference/settings.md)
