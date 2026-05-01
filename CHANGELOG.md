# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.17] — 2026-05-02

### Added
- `ask-user`: session launcher overlay for `new_session` action — spawns a new pi session with the selected model
- `footer`: zone-aware renderer with `zone`, `description`, `shortLabel` on every `FooterSegment`; extended `SemanticColor` with TPS tiers, zone colors, and workflow types
- `footer`: TPS (turns-per-second) tracker segment showing real-time agent throughput
- `footer`: clock and duration segments with live 1-second refresh timer
- `footer`: `hexColor` palette from spec — semantic colors mapped to exact hex values for consistent rendering
- `footer`: `/unipi:footer-help` command with full-label mode and help overlay showing all segments and their meanings
- `footer`: unified 3-category settings TUI (`Groups`, `Segments`, `Theme`) — simplifies the `/unipi:footer-settings` experience
- `autocomplete`: 4-tier sorting for cross-group command suggestions — unipi matches first, then unipi non-matches, system matches, system non-matches
- `autocomplete`: 37 tests for sorting logic, match quality, and cross-group behavior

### Fixed
- `compactor`: compaction stats always zero — fixed 5 interrelated bugs in stats tracking pipeline
- `updater`: resolve `@pi-unipi/unipi` version by package name instead of hardcoded relative path
- `unipi`: include all package `.ts` files in npm bundle (was missing source files)
- `notify`: add `ntfy-config.ts` to `package.json` files array so it ships on npm
- `autocomplete`: sort by match quality across unipi/system items — exact matches ranked above partial
- `footer`: apply hex color palette from spec for consistent segment colors
- `footer`: update workflow color mapping and add thinking level segment color
- `footer`: add TPS tracker icon entries and clock/duration segment definitions

### Changed
- Docs: all package READMEs rewritten with consistent 5-section format
- Docs: package titles deep-linked to their individual README files
- Footer preset updates and label mode support for compact display

## [0.1.16] — 2026-05-01

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
- `@pi-unipi/input-shortcuts` package — keyboard shortcuts with chord overlay, undo/redo, clipboard
- `/unipi:stash-settings` command — configure keyboard shortcuts and input behavior
- Project-level ntfy configuration — each project can use its own ntfy.json
- Theme-aware Markdown rendering in updater TUI overlays

### Fixed
- Updater TUI overlays (`readme-overlay.ts`, `changelog-overlay.ts`, `update-overlay.ts`) — replaced `data.toLowerCase()` with `matchesKey()` to fix arrow key sequences and uppercase keys like `G`
- Updater TUI overlays — replaced raw ANSI codes with `theme.fg()`, `theme.bold()`, `theme.bg()` for consistent styling
- `input-shortcuts`: suppress input listener while overlay is open to prevent background input
- `input-shortcuts`: suppress input listener during undo/redo operations
- `input-shortcuts`: remove undo throttle — allow consecutive undos without delay
- `input-shortcuts`: redo undo snapshot logic — 3 independent triggers for reliable state capture
- `input-shortcuts`: undo for typed text + cut/copy deferred action pattern
- `input-shortcuts`: overlay blocks editor API — refactor to deferred action pattern
- `input-shortcuts`: remove chord timeout — overlay stays open until ESC or action
- `input-shortcuts`: use `unipi:` prefix in `registerCommand()` calls
- `input-shortcuts`: register extension — add barrel file, unipi entry, command registry, info-screen
- `footer`: use icon style system in ralph and workflow segments
- `footer`: remove duplicate icon from WEB segment
- `footer`: add 1-second refresh timer so time segment updates
- `footer`: uppercase status short labels and fix duplicate memory entry

### Changed
- Updater TUI overlays use `truncateToWidth()` and `visibleWidth()` from `@mariozechner/pi-tui` instead of custom implementations
- Updater TUI overlays use proper box drawing frame (`╭╮╰╯│├┤`) matching other overlays

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
