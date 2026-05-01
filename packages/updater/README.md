# @pi-unipi/updater

Auto-updater, changelog browser, and readme browser for the Unipi extension suite.

## Features

- **Auto-updater** — Periodically checks npm registry for new versions, shows update prompt with changelog diff
- **Changelog browser** — TUI overlay listing all versions with dates and status labels (✓ Current, ↑ New)
- **Readme browser** — TUI overlay listing all packages with versions, opens rendered README content

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:readme [package]` | Browse package README files. No arg opens list, with arg opens directly. |
| `/unipi:changelog` | Browse CHANGELOG.md with version list and detail view |
| `/unipi:updater-settings` | Configure check interval and auto-update mode |

## Configuration

Config stored at `~/.unipi/config/updater/config.json`:

```json
{
  "checkIntervalMs": 3600000,
  "autoUpdate": "notify"
}
```

### Options

| Option | Values | Default |
|--------|--------|---------|
| `checkIntervalMs` | `1800000` (30min), `3600000` (1h), `21600000` (6h), `86400000` (1d) | `3600000` (1h) |
| `autoUpdate` | `disabled`, `notify`, `auto` | `notify` |

### Auto-update modes

- **disabled** — No update checks on session start
- **notify** — Show update overlay with changelog diff, user chooses [Y] Update or [n] Skip
- **auto** — Show countdown overlay, auto-install after 5 seconds unless cancelled

## How it works

1. On session start, checks npm registry for `@pi-unipi/unipi` latest version
2. Compares with installed version from `package.json`
3. If newer version found and not previously skipped, shows update overlay
4. User can view changelog diff, update with `[Y]`, or skip with `[n]`
5. Skipped versions are cached — only re-prompted when an even newer version appears
6. Update installs via `pi install npm:@pi-unipi/unipi`

## TUI Overlays

All overlays use keyboard navigation:
- `j`/`k` or ↑/↓ — navigate
- `Enter` — select/open
- `q`/`Esc` — back/close
- `g`/`G` — jump to top/bottom
- `Space` — cycle options (settings overlay)
- `h`/`l` or ←/→ — cycle options (settings overlay)

## Cache

Last-check cache stored at `~/.unipi/cache/updater/last-check.json`:
```json
{
  "lastCheck": "2026-05-01T12:00:00.000Z",
  "latestVersion": "0.1.16",
  "skippedVersion": "0.1.16"
}
```
