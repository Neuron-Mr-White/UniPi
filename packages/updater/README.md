# Updater

Updater tells you when a new UniPi release is on npm and installs it with one key.

`@pi-unipi/updater` · part of [UniPi](../../README.md)

## What it does

- Checks the npm registry for `@pi-unipi/unipi` at session start.
- Shows an update overlay with the changelog entries between your version and the new version.
- Runs `pi install npm:@pi-unipi/unipi` when you press `Y`.
- Remembers a version that you skip. It asks again only for a newer version.
- Opens package READMEs and the changelog in TUI overlays.
- Adds an Updater group to the info screen: installed version, latest version, status and last check.

## Quick start

Updater ships in `@pi-unipi/unipi`. It checks the version of `@pi-unipi/unipi`, so it is useful only with the full suite.

1. Start a pi session. Updater checks npm in the background.
2. If a newer version is on npm, the update overlay opens.
3. Press `Y` to install. Press `n` to skip this version.
4. Restart pi to load the new version.

## Commands

| Command | What it does |
|---|---|
| `/unipi:readme [package]` | Opens the README browser. A package name, for example `utility`, opens that README. |
| `/unipi:changelog` | Opens the changelog browser with a version list and a detail view. |

## Keys

Update overlay:

| Key | What it does |
|---|---|
| `Y` or `y` | Installs the new version. |
| `n`, `q` or `Esc` | Skips this version. |
| `j` / `k` or arrows | Scrolls the changelog. |
| `g` / `G` | Goes to the top or the bottom. |

README and changelog browsers:

| Key | What it does |
|---|---|
| `j` / `k` or arrows | Moves in the list, or scrolls the detail view. |
| `Enter` | Opens the selected item. |
| `g` / `G` | Goes to the top or the bottom. |
| `q` or `Esc` | Goes back to the list, or closes the list. |

## Settings

Open `/unipi:settings` → Updater. The namespace is `updater`.

| Key | Default | What it does |
|---|---|---|
| `checkIntervalMs` | `3600000` (1 hour) | Minimum time between two npm checks. Options: 30 min, 1 hour, 6 hours, 1 day. |
| `autoUpdate` | `notify` | `disabled`: no check. `notify`: the overlay asks you. `auto`: the overlay counts down 5 seconds, then installs. Press `n` to cancel and skip this version. |

## How it works

1. At session start, Updater reads `~/.unipi/cache/updater/last-check.json`.
2. If the last check is older than `checkIntervalMs`, Updater gets the `latest` dist-tag from npm. The request stops after 10 seconds.
3. Updater compares the versions. It never offers a lower version.
4. If the new version is not skipped, the overlay opens. Updater gets the changelog for the new version from GitHub. If that fails, it uses the local `CHANGELOG.md`.
5. The install command stops after 60 seconds. If it fails, the overlay shows the error. Press any key to close it.

A failed npm check is silent. Updater then uses the cached result.

## See also

- [Commands reference](../../docs/reference/commands.md)
- [Settings reference](../../docs/reference/settings.md)
- [Info Screen](../info-screen/README.md)
