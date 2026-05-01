# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `@pi-unipi/updater` package — auto-updater, changelog browser, and readme browser
- `/unipi:readme` command — browse package README.md files in TUI overlay
- `/unipi:changelog` command — browse CHANGELOG.md with version list and detail view
- `/unipi:updater-settings` command — configure check interval and auto-update mode
- Automatic npm registry check on session start (configurable interval: 30min/1h/6h/1d)
- Update notification overlay with changelog diff and one-key install
- Skip-version persistence — skip a version and re-prompt only when newer version appears
- Auto-update mode with countdown and cancel option
- Markdown terminal renderer for changelog and readme content

## [0.1.15] — 2026-04-30

### Added
- `@pi-unipi/footer` package — persistent status bar with live stats from all packages
- Footer settings overlay (`/unipi:footer-settings`) with group and segment toggles
- Thinking level colors and rainbow border for xhigh thinking
- Diff renderer with syntax highlighting via shiki
- Smart-fetch engine for web-api package (default read path)

### Fixed
- Notification dispatch made non-blocking (fire-and-forget)
- Diff renderer return types and shiki import corrections
- Footer extension path alignment with other packages
- Null returns in renderResult replaced with valid components
- Console.log/warn/error calls removed that caused TUI rendering issues

### Changed
- Footer segment icons and labels restructured
- Footer workflow/ralph/memory icons refined

## [0.1.14] — 2026-04-29

### Added
- Compactor UX overhaul — settings overlay, BM25 cache, auto-injection
- Context budget management with `context_budget` config option
- Dry run mode for compaction
- Two-tier skill system (project skills + bundled skills)
- Context savings analytics bridged to info-screen
- Compactor preset system (minimal/balanced/full/custom)
- Compactor search with proximity reranking
- Progressive throttling for large project indexing

### Fixed
- Compactor settings overlay type errors
- Context-mode AnalyticsEngine bridge to info-screen
- Stash artifacts resolved — merged compactor files restored

### Changed
- Compactor token stats info-screen integration improved
- Ralph loop guidance wiring into skill prompts

## [0.1.13] — 2026-04-28

### Added
- Info-screen module status response handling
- MCP catalog sync on session start
- Notify recap model selection (`/unipi:notify-recap-model`)
- ntfy push notification platform support
- Milestone tracking with `/unipi:milestone-onboard` and `/unipi:milestone-update`

### Fixed
- MCP server startup timeout handling
- Notify Gotify header bug
- Compactor init timing issues
- Footer command argument autocomplete

### Changed
- Compactor commands need `unipi:` prefix
- Footer icon style now configurable
