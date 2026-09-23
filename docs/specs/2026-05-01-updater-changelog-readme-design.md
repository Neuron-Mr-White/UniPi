---
title: "Updater, Changelog & Readme Browser"
type: brainstorm
date: 2026-05-01
---

# Updater, Changelog & Readme Browser

## Problem Statement

Users of `@pi-unipi/unipi` have no visibility into when updates are available, what changed between versions, or what each package does — without leaving pi to check GitHub or npm. They run stale versions without knowing, and have no way to review changelogs or read package documentation from within the terminal.

## Context

**Current state:**
- 17 packages in the monorepo, each with a `README.md`
- Root `README.md` with overview and install instructions
- No `CHANGELOG.md` exists yet — no version history tracking
- No update checking mechanism — users must manually `pi install` newer versions
- Kanboard package demonstrates the TUI overlay pattern (list → detail, keyboard nav)
- Notify package demonstrates the settings overlay pattern (toggle options, save/load config)
- Command-enchantment package handles autocomplete for `/unipi:*` commands with `addAutocompleteProvider`
- `getPackageVersion()` from `@pi-unipi/core` resolves installed version from `package.json`
- Config stored in `~/.unipi/config/{package}/config.json` is the established convention
- Info-screen opens on boot — update overlay must not clash with it

**npm registry:**
- `https://registry.npmjs.org/@pi-unipi/unipi` returns `dist-tags.latest` for version checking
- No GitHub Releases exist — changelog will be file-based

**Key files to modify:**
- `packages/core/constants.ts` — add updater constants
- `packages/core/events.ts` — add updater events
- `packages/autocomplete/src/constants.ts` — add 3 commands to registry
- Root `package.json` — add `@pi-unipi/updater` dependency + extension entry
- `packages/unipi/index.ts` — import and mount updater

## Chosen Approach

### New package: `@pi-unipi/updater`

A single package handling all three concerns:
1. **Auto-updater** — periodic npm registry check, `child_process.exec` for install
2. **Changelog browser** — TUI list/detail overlay parsing `CHANGELOG.md`
3. **Readme browser** — TUI list/content overlay discovering package `README.md` files

### Changelog source: Hybrid (bundled + GitHub for latest)

- `CHANGELOG.md` lives at repo root, follows [Keep a Changelog](https://keepachangelog.com) format
- Shipped inside the npm package — available locally without network
- For pre-update checks: GitHub raw fetch of `CHANGELOG.md` from `main` branch shows unreleased/next-version changes
- Top section uses `## [Unreleased]` for changes merged but not yet published

### Update delivery: `child_process.exec`

- Both `notify` and `auto` modes use `exec("pi install npm:@pi-unipi/{package}")`
- Runs truly in background — no agent involvement, no `!!` paste hack
- Only checks the user's directly installed package (e.g. `@pi-unipi/unipi` umbrella resolves sub-deps)
- Status notification on completion: "✓ Updated to 0.1.16. Restart pi to apply."

### Rendering: TUI overlays (no HTTP server, no browser)

- Changelog: version list → Enter → scrollable detail view → Esc back
- Readme: package list → Enter → scrollable content view → Esc back
- Markdown rendered as formatted terminal output (bold headings, bullet points, dim code)

## Why This Approach

**Why one package, not three:**
- Changelog and readme browsers are closely tied to the update notification — when an update is available, the overlay shows the changelog. Splitting into separate packages would create circular dependencies and fragmented UX.
- The settings for update checking naturally own the changelog/readme commands too.

**Why `child_process.exec` over `pasteToEditor`:**
- Runs truly in background without agent involvement
- No dependency on `!!` command syntax or paste handling behavior
- Cleaner separation — extension manages the lifecycle, not the agent's conversation

**Why TUI over HTML browser:**
- No port allocation, no server lifecycle, no PID management
- Stays in the terminal — no context switching
- Kanboard already demonstrated the list→detail TUI pattern works well
- Markdown in readmes/changelogs is simple enough for terminal rendering

**Why bundled CHANGELOG.md:**
- Zero network dependency for viewing historical changelog
- Standard format — tooling support everywhere
- GitHub raw fetch only needed for "what's new" in upcoming versions

## Design

### Config

**Path:** `~/.unipi/config/updater/config.json`

```typescript
interface UpdaterConfig {
  /** How often to check for updates */
  checkInterval: "30min" | "1h" | "6h" | "1d";
  /** Update behavior */
  autoUpdate: "disabled" | "notify" | "auto";
}
```

**Defaults:** `checkInterval: "1h"`, `autoUpdate: "notify"`

**Check cache:** `~/.unipi/cache/updater/last-check.json`
```typescript
interface LastCheckCache {
  lastCheckTime: string;    // ISO timestamp
  latestVersion: string;    // latest from npm registry
}
```

### Commands

| Command | Description |
|---------|-------------|
| `/unipi:readme [package]` | Browse package readmes. No arg = root README. Autosuggests package names. |
| `/unipi:changelog` | View changelog with version labels (Current / New / historical) |
| `/unipi:updater-settings` | Configure check interval and auto-update behavior |

### Changelog TUI

**List view:**
```
╭─────────────── Changelog ───────────────╮
│ ▸ [0.1.16] ↑ New    — Not Yet Released  │
│   [0.1.15] ✓ Current — 2026-04-30       │
│   [0.1.14]           — 2026-04-29       │
│   [0.1.13]           — 2026-04-28       │
│                                         │
│  ↑↓ navigate · Enter view · q close     │
╰─────────────────────────────────────────╯
```

**Detail view (Enter on a version):**
```
╭──── 0.1.16 — Not Yet Released ────╮
│ ↑ New                              │
│                                    │
│ ### Added                          │
│ • Auto-updater with configurable   │
│   check interval and update mode   │
│ • /unipi:readme command            │
│ • /unipi:changelog command         │
│                                    │
│ Esc/q ← back                      │
╰────────────────────────────────────╯
```

**Version labeling:**
- Version matching installed `@pi-unipi/unipi` → `✓ Current` (teal accent)
- Version newer than installed → `↑ New` (amber)
- Older versions → no label, neutral

**Navigation:** `↑↓`/`j/k` navigate, `Enter` view detail, `Esc`/`q` back or close

### Readme TUI

**List view:**
```
╭─────────────── Readme ──────────────╮
│ ▸ unipi        v0.1.15              │
│   core         v0.1.14              │
│   workflow     v0.1.15              │
│   ralph        v0.1.9               │
│   memory       v0.1.12              │
│   ...                              │
│                                    │
│  ↑↓ navigate · Enter view · q close │
╰─────────────────────────────────────╯
```

**Content view (Enter on a package):**
Scrollable rendered markdown content with:
- Headings → bold/underline
- Bullets → `•`
- Code blocks → dim background
- Inline code → dim formatting
- Links → underlined (can't follow, just visible)

**Navigation:** `↑↓`/`j/k` scroll, `Esc`/`q` back to list

**No-arg behavior:** `/unipi:readme` without args opens directly to the root README content view (no list). With an arg like `/unipi:readme notify`, opens directly to that package's README content view.

**Autosuggest:** When user types `/unipi:readme `, the autocomplete suggests all package short names (core, workflow, ralph, memory, info-screen, subagents, btw, web-api, compactor, notify, utility, ask-user, mcp, milestone, kanboard, footer, updater).

### Update Flow

**On `session_start`:**

1. Read `UpdaterConfig` from `~/.unipi/config/updater/config.json`
2. If `autoUpdate: "disabled"` → stop
3. Read `~/.unipi/cache/updater/last-check.json` for `lastCheckTime`
4. Calculate interval from config (`30min` = 1800000ms, `1h` = 3600000ms, `6h` = 21600000ms, `1d` = 86400000ms)
5. If interval hasn't elapsed since `lastCheckTime` → stop
6. Fetch `https://registry.npmjs.org/@pi-unipi/unipi` → extract `dist-tags.latest`
7. Update `last-check.json` with current timestamp and latest version
8. Compare `latest` with locally installed version (from `getPackageVersion()`)
9. If no update available → stop
10. If update available:
    - **notify**: show update overlay with changelog sections for all versions newer than installed + `[Y] Update  [n] Skip`
    - **auto**: show same overlay, auto-press Y after 3 seconds
11. On confirm: `child_process.exec("pi install npm:@pi-unipi/unipi")`
12. On completion: notify "✓ Updated to {version}. Restart pi to apply."

**Info-screen coexistence:** The npm registry fetch is async with network latency. Info-screen opens synchronously on boot. The update overlay naturally appears after info-screen, stacking on top. No timing conflict.

### Update Overlay

**When update is available:**
```
╭────────── Update Available ──────────╮
│                                      │
│  @pi-unipi/unipi                     │
│  0.1.15 → 0.1.16                     │
│                                      │
│  ── What's New ──                    │
│                                      │
│  ### Added                           │
│  • Auto-updater with configurable    │
│    check interval and update mode    │
│  • /unipi:readme command             │
│  • /unipi:changelog command          │
│                                      │
│  [Y] Update   [n] Skip               │
│                                      │
╰──────────────────────────────────────╯
```

**In `auto` mode:** Countdown shown: "Auto-updating in 3... 2... 1..." — user can press `n` to cancel.

### Settings TUI

**`/unipi:updater-settings`:**
```
╭────────── Updater Settings ──────────╮
│                                      │
│   Check Interval                     │
│   ▸ ● 30min   ○ 1h   ○ 6h   ○ 1d   │
│                                      │
│   Auto Update                        │
│   ▸ ○ Disabled   ○ Notify   ● Auto  │
│                                      │
│   ↑↓ navigate · Space select ·       │
│   Enter save · Esc cancel            │
╰──────────────────────────────────────╯
```

Two rows. `Space` cycles through options. `Enter` saves. `Esc` cancels.

### Changelog Format

**Path:** Repo root `CHANGELOG.md`

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]
### Added
- Auto-updater with configurable check interval and update mode
- `/unipi:readme` command — browse package readmes in TUI
- `/unipi:changelog` command — view changelog with version awareness
- `/unipi:updater-settings` command — configure update behavior

## [0.1.15] — 2026-04-30
### Added
- Footer package with persistent status bar
### Fixed
- Notification dispatch made non-blocking

## [0.1.14] — 2026-04-29
...
```

**Rules:**
- `## [Unreleased]` = changes merged but not yet published
- On release: rename `[Unreleased]` → `[x.y.z] — YYYY-MM-DD`, add new `[Unreleased]` header
- Sections: `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`
- Shipped inside the npm package — available locally without network
- For pre-update: GitHub raw fetch of `CHANGELOG.md` from `main` branch shows unreleased changes

### Readme Discovery

**Resolution logic:**
1. Resolve installed location of `@pi-unipi/unipi` via `import.meta.url` — gives us the package root
2. Root README: `{unipiPackageDir}/README.md` (walk up from package dir to repo root, or use `../../README.md` relative)
3. Package README: `node_modules/@pi-unipi/{name}/README.md` — workspace packages are hoisted/symlinked
4. Map of short names to `@pi-unipi/{name}` already exists in `MODULES` constant in core

**Fallback:** If a README.md doesn't exist for a package, show "No readme available for {package}" in the content view.

### Events

New events in `@pi-unipi/core`:

```typescript
/** Update check completed */
UPDATE_CHECK: "unipi:updater:check",

/** Update available found */
UPDATE_AVAILABLE: "unipi:updater:available",

/** Update applied successfully */
UPDATE_APPLIED: "unipi:updater:applied",

/** Update check or install failed */
UPDATE_ERROR: "unipi:updater:error",
```

### Package Structure

```
packages/updater/
├── index.ts                    # Extension entry — register commands, session lifecycle
├── commands.ts                 # /unipi:readme, /unipi:changelog, /unipi:updater-settings
├── settings.ts                 # Config load/save, defaults, validation
├── types.ts                    # UpdaterConfig, ChangelogEntry, ReadmeEntry, etc.
├── checker.ts                  # npm registry check, version comparison, caching
├── installer.ts                # child_process.exec wrapper for pi install
├── changelog.ts                # Parse CHANGELOG.md → structured ChangelogEntry[]
├── readme.ts                   # Discover package readme paths
├── markdown.ts                 # Terminal markdown renderer (headings, bullets, code)
├── tui/
│   ├── changelog-overlay.ts    # Version list + detail view
│   ├── readme-overlay.ts       # Package list + content view
│   ├── update-overlay.ts       # Update available prompt with changelog
│   └── settings-overlay.ts     # Check interval + auto-update config
└── skills/
    └── configure-updater/
        └── SKILL.md            # Skill for configuring updater settings
```

## Implementation Checklist

- [x] Create `packages/updater/` package scaffold (package.json, index.ts, types.ts) — covered in Task 1
- [x] Add `CHANGELOG.md` to repo root with format convention and existing version entries — covered in Task 14
- [x] Implement `settings.ts` — config load/save with defaults and validation — covered in Task 2
- [x] Implement `types.ts` — UpdaterConfig, ChangelogEntry, ReadmeEntry, event payloads — covered in Task 1
- [x] Implement `checker.ts` — npm registry fetch, version comparison, last-check cache — covered in Task 6
- [x] Implement `installer.ts` — child_process.exec wrapper with success/error callbacks — covered in Task 7
- [x] Implement `changelog.ts` — parse CHANGELOG.md into structured entries — covered in Task 3
- [x] Implement `readme.ts` — discover package readme paths from installed location — covered in Task 4
- [x] Implement `markdown.ts` — terminal markdown renderer (headings, bullets, code blocks, inline code) — covered in Task 5
- [x] Implement `tui/changelog-overlay.ts` — version list with Current/New labels, detail view on Enter — covered in Task 8
- [x] Implement `tui/readme-overlay.ts` — package list, content view on Enter, no-arg direct open — covered in Task 9
- [x] Implement `tui/update-overlay.ts` — update prompt with inline changelog, auto-countdown, Y/n — covered in Task 10
- [x] Implement `tui/settings-overlay.ts` — check interval radio, auto-update radio, save/cancel — covered in Task 11
- [x] Implement `commands.ts` — register /unipi:readme, /unipi:changelog, /unipi:updater-settings — covered in Task 12
- [x] Implement `index.ts` — extension entry with session_start update check lifecycle — covered in Task 13
- [x] Add updater constants to `packages/core/constants.ts` (MODULES.UPDATER, UPDATER_COMMANDS, UPDATER_DIRS) — covered in Task 1
- [x] Add updater events to `packages/core/events.ts` (UPDATE_CHECK, UPDATE_AVAILABLE, UPDATE_APPLIED, UPDATE_ERROR) — covered in Task 1
- [x] Add updater commands to `packages/autocomplete/src/constants.ts` (COMMAND_REGISTRY, COMMAND_DESCRIPTIONS) — covered in Task 12
- [x] Add `@pi-unipi/updater` dependency to root package.json + pi.extensions entry — covered in Task 15
- [x] Import and mount updater in `packages/unipi/index.ts` — covered in Task 15
- [x] Add autosuggest for `/unipi:readme` package argument in autocomplete provider — covered in Task 12

## Open Questions (Resolved)

- ~~Should the GitHub raw fetch for unreleased changelog be configurable?~~ → No. Bundled changelog only. No GitHub fetch.
- ~~Should we show a notification in the info-screen group for "update available" status?~~ → Yes. Task 16 adds info-screen group.
- ~~Should `auto` mode persist a "skip this version" choice?~~ → Yes. `skippedVersion` persisted in last-check cache.

## Out of Scope

- Auto-restart of pi after update (user must restart manually)
- Updating individual sub-packages independently (only the directly installed package is checked)
- Rollback/downgrade functionality
- Semantic version constraint checking (just compares latest vs installed)
- Diff view between versions
