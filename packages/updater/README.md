# @pi-unipi/updater

Checks npm for new versions on session start, shows a changelog diff, and lets you update with one keypress. Also provides TUI browsers for package READMEs and the changelog.

The update overlay appears automatically when a newer version is found. Press `Y` to update, `n` to skip. Skipped versions are cached — you only get re-prompted when an even newer version appears.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:readme [package]` | Browse package README files in TUI overlay |
| `/unipi:changelog` | Browse CHANGELOG.md with version list and detail view |
| `/unipi:updater-settings` | Configure check interval and auto-update mode |

### TUI Controls

| Key | Action |
|-----|--------|
| `j/k` or Up/Down | Navigate |
| `Enter` | Select/open |
| `q/Esc` | Back/close |
| `g/G` | Jump to top/bottom |
| `Space` | Cycle options (settings) |
| `h/l` or Left/Right | Cycle options (settings) |

## Special Triggers

On session start, updater checks the npm registry for `@pi-unipi/unipi`. If a newer version exists and wasn't previously skipped, it shows the update overlay with changelog diff. This runs once per session, respecting the check interval config.

Updater registers with the info-screen dashboard, showing installed version, latest version, update status, and last check time.

## How Updates Work

1. Session start triggers npm registry check
2. Compare latest version with installed version
3. If newer and not skipped, show update overlay
4. User views changelog diff, presses `Y` to update or `n` to skip
5. Update runs `pi install npm:@pi-unipi/unipi`
6. Skipped version cached — re-prompted only for newer versions

## Configurables

Config stored at `~/.unipi/config/updater/config.json`:

```json
{
  "checkIntervalMs": 3600000,
  "autoUpdate": "notify"
}
```

| Option | Values | Default |
|--------|--------|---------|
| `checkIntervalMs` | 1800000 (30min), 3600000 (1h), 21600000 (6h), 86400000 (1d) | 3600000 (1h) |
| `autoUpdate` | disabled, notify, auto | notify |

### Auto-update Modes

- **disabled** — No update checks on session start
- **notify** — Show overlay with changelog, user chooses Y/n
- **auto** — Show countdown, auto-install after 5 seconds unless cancelled

### Cache

Last-check cache at `~/.unipi/cache/updater/last-check.json`:

```json
{
  "lastCheck": "2026-05-01T12:00:00.000Z",
  "latestVersion": "0.1.16",
  "skippedVersion": "0.1.16"
}
```

## License

MIT
