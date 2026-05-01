---
name: configure-updater
description: Guide for using and configuring the Unipi updater — auto-update, changelog browser, and readme browser.
---

# Configure Updater

The `@pi-unipi/updater` package provides auto-update checking, a changelog browser, and a readme browser.

## Commands

### `/unipi:readme [package]`

Browse README.md files for all unipi packages.

- **No argument** — Opens a list of all packages with their versions. Select one to read its README.
- **With argument** (e.g., `/unipi:readme workflow`) — Opens that package's README directly.

### `/unipi:changelog`

Browse the root CHANGELOG.md in a TUI overlay.

- Shows version list with dates and status labels (✓ Current, ↑ New)
- Select a version to view its changelog details (Added, Fixed, Changed sections)
- Follows [Keep a Changelog](https://keepachangelog.com) format

### `/unipi:updater-settings`

Configure the updater module.

**Settings:**
- **Check Interval** — How often to check npm for updates (30min / 1h / 6h / 1d)
- **Auto Update** — What happens when an update is found:
  - `disabled` — No update checks on session start
  - `notify` — Show update overlay, user chooses to update or skip
  - `auto` — Auto-install after 5-second countdown (press `n` to cancel)

## Config File

Config stored at `~/.unipi/config/updater/config.json`:

```json
{
  "checkIntervalMs": 3600000,
  "autoUpdate": "notify"
}
```

## Cache

Last-check cache at `~/.unipi/cache/updater/last-check.json`:
- Tracks when the last npm check was performed
- Stores the latest version found
- Remembers skipped versions (user pressed `n` to skip)
- Re-prompts only when a newer version than the skipped one appears

## Navigation

All TUI overlays support:
- `j`/`k` or ↑/↓ — Navigate
- `Enter` — Select/open
- `q`/`Esc` — Back/close
- `g`/`G` — Jump to top/bottom
- `Space` — Cycle options (settings)
- `h`/`l` or ←/→ — Cycle options (settings)
