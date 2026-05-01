---
title: "Updater, Changelog & Readme Browser — Implementation Plan"
type: plan
date: 2026-05-01
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-01-updater-changelog-readme-design.md
---

# Updater, Changelog & Readme Browser — Implementation Plan

## Overview

Create `@pi-unipi/updater` — a single package that provides:
1. **Auto-updater** — periodic npm registry check, `child_process.exec` for install
2. **Changelog browser** — TUI list/detail overlay parsing bundled `CHANGELOG.md`
3. **Readme browser** — TUI list/content overlay discovering package README.md files

Plus: root `CHANGELOG.md`, core constants/events, autocomplete registration, and info-screen integration.

**Key decisions (from spec review):**
- No GitHub raw fetch — bundled changelog is sufficient. Users see changes between their installed version and latest.
- Skip-version persistence — `skippedVersion` in last-check cache, re-prompt only when a newer version appears.
- Info-screen group — one row showing update status (available/current).
- Work on main branch — new isolated package, additive-only changes to existing files.

## Tasks

- completed: Task 1 — Core scaffold and types
  - Description: Create `packages/updater/` directory with `package.json`, `index.ts` (re-exports), `types.ts` (all interfaces). Add `MODULES.UPDATER`, `UPDATER_COMMANDS`, `UPDATER_DIRS` to `packages/core/constants.ts`. Add `UPDATE_CHECK`, `UPDATE_AVAILABLE`, `UPDATE_APPLIED`, `UPDATE_ERROR` events to `packages/core/events.ts`.
  - Dependencies: None
  - Acceptance Criteria: Package exists with valid `package.json`. Types compile. Core constants/events exported and importable.
  - Steps:
    1. Create `packages/updater/package.json` following footer pattern (pi-package, workspace dep on `@pi-unipi/core`, peerDeps on `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui`)
    2. Create `packages/updater/types.ts` — `UpdaterConfig`, `LastCheckCache`, `ChangelogEntry`, `ReadmeEntry`, event payload interfaces
    3. Create `packages/updater/index.ts` — re-export default from `./src/index.js` and types
    4. Add to `packages/core/constants.ts`: `MODULES.UPDATER`, `UPDATER_COMMANDS` (README, CHANGELOG, UPDATER_SETTINGS), `UPDATER_DIRS` (CONFIG, CACHE)
    5. Add to `packages/core/events.ts`: `UPDATE_CHECK`, `UPDATE_AVAILABLE`, `UPDATE_APPLIED`, `UPDATE_ERROR` with payload interfaces
    6. Verify `tsc --noEmit` passes

- completed: Task 2 — Settings and config
  - Description: Implement `settings.ts` — config load/save/defaults for `~/.unipi/config/updater/config.json`. Implement last-check cache read/write in `checker.ts`.
  - Dependencies: Task 1
  - Acceptance Criteria: Config loads with defaults when missing. Saves correctly. Cache read/write works. Validation rejects invalid intervals/modes.
  - Steps:
    1. Create `packages/updater/src/settings.ts` — `loadConfig()`, `saveConfig()`, `DEFAULT_CONFIG`, `mergeWithDefaults()`, `validateConfig()` following notify/settings.ts pattern
    2. Create `packages/updater/src/cache.ts` — `readLastCheck()`, `writeLastCheck()` for `~/.unipi/cache/updater/last-check.json`
    3. Ensure cache directory creation (`mkdirSync recursive`) on write
    4. Test: loadConfig returns defaults on empty, save then load round-trips

- completed: Task 3 — Changelog parser
  - Description: Implement `changelog.ts` — parse `CHANGELOG.md` into structured `ChangelogEntry[]`. Follow Keep a Changelog format: `## [Unreleased]`, `## [x.y.z] — YYYY-MM-DD`, sections `### Added/Changed/Fixed/etc`.
  - Dependencies: Task 1
  - Acceptance Criteria: Parser correctly extracts versions, dates, and sections from a well-formatted CHANGELOG.md. Handles `[Unreleased]` (no date). Returns empty array for missing file.
  - Steps:
    1. Create `packages/updater/src/changelog.ts` — `parseChangelog(filePath: string): ChangelogEntry[]`
    2. Regex split on `## [version]` headers, extract version, date, and body
    3. Within each version block, split on `### Section` headers to build section map
    4. Handle edge cases: missing file, empty file, `[Unreleased]` with no date
    5. Test with sample CHANGELOG.md content

- completed: Task 4 — Readme discovery
  - Description: Implement `readme.ts` — discover package README.md paths. Root README from unipi package root. Package READMEs from `node_modules/@pi-unipi/{name}/README.md`. Map short names to full package names via MODULES constant.
  - Dependencies: Task 1
  - Acceptance Criteria: Returns correct paths for all 17+ packages. Falls back gracefully when README missing. No-arg returns root README.
  - Steps:
    1. Create `packages/updater/src/readme.ts` — `discoverReadmes(): ReadmeEntry[]`, `resolveReadmePath(packageName?: string): string | null`
    2. Build package name map from MODULES constant (short name → `@pi-unipi/{name}`)
    3. Resolve unipi root via `import.meta.url` walk-up or `require.resolve`
    4. Check `fs.existsSync` for each README, filter to existing ones
    5. Return structured list with name, version (from package.json), path

- completed: Task 5 — Markdown terminal renderer
  - Description: Implement `markdown.ts` — render markdown to terminal-formatted strings. Headings → bold/underline, bullets → `•`, code blocks → dim background, inline code → dim, links → underlined text. Used by both changelog detail and readme content views.
  - Dependencies: None
  - Acceptance Criteria: Renders headings, bullet lists, code blocks, inline code, bold/italic, and links as readable terminal output. Handles line wrapping to terminal width.
  - Steps:
    1. Create `packages/updater/src/markdown.ts` — `renderMarkdown(text: string, width: number): string[]`
    2. Process line-by-line: detect headings (`#`, `##`, `###`), bullet lists (`- `, `* `), code fences (`` ``` ``), blank lines
    3. Apply ANSI formatting: bold for headings, dim for code, underline for links
    4. Handle inline formatting: `**bold**`, `` `code` ``, `[text](url)`
    5. Word-wrap long lines to fit width

- completed: Task 6 — NPM registry checker
  - Description: Implement `checker.ts` — fetch `https://registry.npmjs.org/@pi-unipi/unipi`, extract `dist-tags.latest`, compare with installed version via `getPackageVersion()`. Use last-check cache to avoid redundant fetches.
  - Dependencies: Task 2
  - Acceptance Criteria: Correctly fetches latest version from npm. Compares semver. Respects check interval from config. Updates cache after check. Returns `{ updateAvailable, latestVersion, currentVersion }`.
  - Steps:
    1. Create `packages/updater/src/checker.ts` — `checkForUpdates(): Promise<UpdateCheckResult>`
    2. Read config, check cache timestamp, skip if interval not elapsed
    3. Fetch `https://registry.npmjs.org/@pi-unipi/unipi` with `fetch()` (Node 18+)
    4. Extract `dist-tags.latest` from JSON response
    5. Compare with installed version using simple string comparison (no semver lib needed — versions are always `x.y.z`)
    6. Write cache with current timestamp and latest version
    7. Handle network errors gracefully — log and return no update

- completed: Task 7 — Update installer
  - Description: Implement `installer.ts` — wrap `child_process.exec("pi install npm:@pi-unipi/unipi")` with success/error callbacks. Emit `UPDATE_APPLIED` or `UPDATE_ERROR` events.
  - Dependencies: Task 1
  - Acceptance Criteria: Executes install command. Resolves with new version on success. Rejects with error on failure. Emits appropriate events.
  - Steps:
    1. Create `packages/updater/src/installer.ts` — `installUpdate(): Promise<{ success: boolean; version?: string; error?: string }>`
    2. Use `child_process.exec` with promise wrapper
    3. On success: emit `UPDATE_APPLIED` event
    4. On error: emit `UPDATE_ERROR` event
    5. Return structured result

- completed: Task 8 — Changelog TUI overlay
  - Description: Implement `tui/changelog-overlay.ts` — version list with Current/New labels, Enter opens detail view, Esc/q back. Uses `ctx.ui.custom()` overlay API (same pattern as kanboard overlay).
  - Dependencies: Task 3, Task 5
  - Acceptance Criteria: Shows version list with proper labels (✓ Current, ↑ New). Enter opens scrollable detail. Esc/q navigates back. Handles empty changelog gracefully.
  - Steps:
    1. Create `packages/updater/src/tui/changelog-overlay.ts`
    2. Implement Component pattern: `handleInput`, `render`, `setTheme`, `onClose`, `requestRender`
    3. List view: render versions with status icons, date, scroll with ↑↓/j/k
    4. Detail view: render markdown content for selected version, scroll with ↑↓/j/k
    5. Label logic: version == installed → "✓ Current" (teal), version > installed → "↑ New" (amber)
    6. Navigation: Enter → detail, Esc/q in detail → list, Esc/q in list → close

- completed: Task 9 — Readme TUI overlay
  - Description: Implement `tui/readme-overlay.ts` — package list with versions, Enter opens content view. No-arg `/unipi:readme` opens directly to root README content. With arg, opens directly to that package's content.
  - Dependencies: Task 4, Task 5
  - Acceptance Criteria: Shows package list with version numbers. Enter opens rendered readme content. No-arg mode opens root README directly. Arg mode skips list and opens specified package. Esc/q navigates back.
  - Steps:
    1. Create `packages/updater/src/tui/readme-overlay.ts`
    2. Implement Component pattern same as changelog overlay
    3. List view: render package names with versions, scroll with ↑↓/j/k
    4. Content view: render markdown via `renderMarkdown()`, scroll with ↑↓/j/k
    5. Support `openDirect?: string` parameter — skip list, open specific package
    6. Fallback message when README not found

- completed: Task 10 — Update available overlay
  - Description: Implement `tui/update-overlay.ts` — shows when update found on session start. Displays version diff, inline changelog sections for versions newer than installed, [Y] Update / [n] Skip prompt. Auto mode: countdown with cancel option.
  - Dependencies: Task 3, Task 5, Task 7
  - Acceptance Criteria: Shows correct version diff. Displays changelog for new versions. Y triggers install. n skips (persists to cache). Auto mode counts down, n cancels. Handles install success/error notifications.
  - Steps:
    1. Create `packages/updater/src/tui/update-overlay.ts`
    2. Render header: package name, current → latest version
    3. Render changelog sections for all versions between installed and latest
    4. Prompt: `[Y] Update  [n] Skip`
    5. On Y: call `installUpdate()`, show progress, notify on completion
    6. On n: write `skippedVersion` to cache, close
    7. Auto mode: show countdown "Auto-updating in 3... 2... 1...", n cancels

- completed: Task 11 — Settings TUI overlay
  - Description: Implement `tui/settings-overlay.ts` — check interval radio (30min/1h/6h/1d), auto-update radio (disabled/notify/auto). Space cycles options, Enter saves, Esc cancels.
  - Dependencies: Task 2
  - Acceptance Criteria: Shows current config values. Space cycles through options. Enter saves to disk. Esc discards changes. Two-row layout, clean and minimal.
  - Steps:
    1. Create `packages/updater/src/tui/settings-overlay.ts`
    2. Two rows: Check Interval and Auto Update
    3. ↑↓/j/k navigate between rows
    4. Space cycles through options in current row
    5. Enter → saveConfig, close
    6. Esc → discard, close

- completed: Task 12 — Command registration
  - Description: Implement `commands.ts` — register `/unipi:readme [package]`, `/unipi:changelog`, `/unipi:updater-settings`. Readme command handles optional arg for direct package open. Add autocomplete entries to `packages/autocomplete/src/constants.ts`.
  - Dependencies: Task 8, Task 9, Task 10, Task 11
  - Acceptance Criteria: All 3 commands registered with correct prefixes. `/unipi:readme` opens readme overlay (direct or list). `/unipi:changelog` opens changelog overlay. `/unipi:updater-settings` opens settings overlay. Autocomplete entries present in COMMAND_REGISTRY and COMMAND_DESCRIPTIONS.
  - Steps:
    1. Create `packages/updater/src/commands.ts` — `registerCommands(pi, state)`
    2. `/unipi:readme` — parse args, call `showReadmeOverlay(ctx, packageName?)`
    3. `/unipi:changelog` — call `showChangelogOverlay(ctx)`
    4. `/unipi:updater-settings` — call `showSettingsOverlay(ctx)`
    5. Add to `packages/autocomplete/src/constants.ts`: COMMAND_REGISTRY entries ("updater" package), COMMAND_DESCRIPTIONS, PACKAGE_ORDER, PACKAGE_COLORS, PACKAGE_LABELS

- completed: Task 13 — Extension entry point
  - Description: Implement `src/index.ts` — extension entry with `session_start` lifecycle. On boot: load config, check cache, fetch npm registry, show update overlay if available. Register commands, emit MODULE_READY. Register skills discovery.
  - Dependencies: Task 6, Task 10, Task 12
  - Acceptance Criteria: Update check runs on session start (respecting config). Update overlay appears when update found. Commands registered. Module ready event emitted. Skills directory discovered.
  - Steps:
    1. Create `packages/updater/src/index.ts` — default export function
    2. `pi.on("session_start")`: load config, run `checkForUpdates()`, if update available and not skipped → show update overlay
    3. `pi.on("session_shutdown")`: cleanup if needed
    4. `pi.on("resources_discover")`: return skillPaths
    5. Call `registerCommands(pi, state)`
    6. Emit `MODULE_READY` with commands list
    7. Create `packages/updater/index.ts` re-export entry

- completed: Task 14 — CHANGELOG.md and README.md
  - Description: Create root `CHANGELOG.md` following Keep a Changelog format. Add `[Unreleased]` section with updater features. Add recent version entries based on git history. Create `packages/updater/README.md`.
  - Dependencies: None
  - Acceptance Criteria: CHANGELOG.md exists at root with proper format. `[Unreleased]` section lists upcoming updater features. Recent versions documented. Updater README.md exists with overview.
  - Steps:
    1. Create `CHANGELOG.md` at repo root
    2. Add `## [Unreleased]` with updater features listed
    3. Add `## [0.1.15] — 2026-04-30` with footer and recent changes
    4. Add `## [0.1.14] — 2026-04-29` and earlier if git log provides data
    5. Create `packages/updater/README.md` with package overview, commands, config

- completed: Task 15 — Integration wiring
  - Description: Wire updater into the umbrella package. Add `@pi-unipi/updater` dependency to root `package.json`. Add extension entry to `pi.extensions`. Import and mount in `packages/unipi/index.ts`. Update root `README.md` packages table.
  - Dependencies: Task 13
  - Acceptance Criteria: Updater loads when unipi is installed. All 3 commands available. Root README lists updater package. No import errors.
  - Steps:
    1. Add `"@pi-unipi/updater": "*"` to root `package.json` dependencies
    2. Add `"node_modules/@pi-unipi/updater/src/index.ts"` to `pi.extensions` array
    3. Add `"node_modules/@pi-unipi/updater/skills"` to `pi.skills` array
    4. Import and call `updater(pi)` in `packages/unipi/index.ts`
    5. Add updater row to README.md packages table
    6. Add 3 commands to README.md commands table
    7. Run `tsc --noEmit` to verify

- completed: Task 16 — Info-screen integration
  - Description: Register an updater group in the info-screen dashboard showing update status (current version, latest version, last check time). Subscribe to `UPDATE_CHECK` and `UPDATE_AVAILABLE` events to update in real-time.
  - Dependencies: Task 13
  - Acceptance Criteria: Info-screen shows "Updater" group with version info. Updates reactively when check completes. Shows "✓ Up to date" or "↑ Update available (0.1.16)".
  - Steps:
    1. In `src/index.ts` or a dedicated `src/info-group.ts`, register info-screen group on `session_start`
    2. Group data: installed version, latest version (or "checking..."), last check time
    3. Subscribe to `UPDATE_CHECK` and `UPDATE_AVAILABLE` events to refresh data
    4. Emit `INFO_DATA_UPDATED` when data changes

- completed: Task 17 — Updater skill
  - Description: Create `skills/configure-updater/SKILL.md` for the skill system. Brief guide explaining the 3 commands and config options.
  - Dependencies: None
  - Acceptance Criteria: Skill file exists, describes commands and settings, follows existing skill format.
  - Steps:
    1. Create `packages/updater/skills/configure-updater/SKILL.md`
    2. Document: `/unipi:readme`, `/unipi:changelog`, `/unipi:updater-settings`
    3. Document config options: checkInterval, autoUpdate

## Sequencing

```
Task 1 (scaffold/types) ─┬─→ Task 2 (settings) ──→ Task 6 (checker) ──→ Task 13 (entry) ──→ Task 15 (integration)
                          │                                                    ↑                    ↑
                          ├─→ Task 3 (changelog parser) ─→ Task 8 (changelog TUI) ─┘                    │
                          │                          └─→ Task 10 (update overlay) ─┘                    │
                          ├─→ Task 4 (readme discovery) ─→ Task 9 (readme TUI) ──────────────────────┘
                          ├─→ Task 7 (installer) ──→ Task 10
                          │
Task 5 (markdown renderer) ─→ Task 8, Task 9, Task 10
Task 11 (settings TUI) ─────→ Task 12 (commands) ──→ Task 13
Task 14 (CHANGELOG.md) ── standalone
Task 16 (info-screen) ── after Task 13
Task 17 (skill) ── standalone
```

**Parallel opportunities:**
- Tasks 1, 5, 14, 17 can start immediately (no deps)
- Tasks 2, 3, 4, 7 can start after Task 1
- Task 11 can start after Task 2
- Tasks 6, 8, 9, 10 can start after their respective deps
- Task 12 after TUI overlays (8, 9, 10, 11)
- Task 13 after checker + commands
- Task 15 after 13
- Task 16 after 13

## Risks

- **npm registry fetch may fail in restricted networks** — checker handles this gracefully (returns no update)
- **`child_process.exec` for install may hang** — add timeout (60s) to exec wrapper
- **CHANGELOG.md doesn't exist yet on older versions** — parser returns empty array, overlay shows "No changelog available"
- **README paths vary by install method** — discovery uses `import.meta.url` + walk-up, should work for both workspace and npm installs
- **pi-tui Component API may have changed** — use kanboard overlay as reference, it's the most recent working example

---

## Reviewer Remarks

REVIEWER-REMARK: Done 17/17

All 17 tasks complete and verified against acceptance criteria:

- **Task 1 (scaffold/types):** ✅ `packages/updater/` exists with `package.json`, `types.ts`, `index.ts`. Core constants (`MODULES.UPDATER`, `UPDATER_COMMANDS`, `UPDATER_DIRS`) and events (`UPDATE_CHECK/AVAILABLE/APPLIED/ERROR`) with payload interfaces all present in core.
- **Task 2 (settings/config):** ✅ `settings.ts` has `loadConfig()`, `saveConfig()`, `DEFAULT_CONFIG`, `validateConfig()`, `getIntervalOptions()`. `cache.ts` has `readLastCheck()`, `writeLastCheck()`, `isCheckDue()`, `writeSkippedVersion()`, `isVersionSkipped()` with `mkdirSync recursive`.
- **Task 3 (changelog parser):** ✅ `changelog.ts` parses `## [version]` and `### Section` headers. Handles `[Unreleased]`, missing files, empty files. Exports `parseChangelog()`, `getNewerVersions()`, `compareVersions()`.
- **Task 4 (readme discovery):** ✅ `readme.ts` maps 20 short names to full `@pi-unipi/` package names via MODULES. Checks both workspace and node_modules layouts. Exports `discoverReadmes()` and `resolveReadmePath()`.
- **Task 5 (markdown renderer):** ✅ `markdown.ts` handles headings (bold/underline), bullets (•), code blocks (dim), inline code, bold, italic, links. Word-wraps to terminal width.
- **Task 6 (npm checker):** ✅ `checker.ts` fetches `registry.npmjs.org/@pi-unipi/unipi`, extracts `dist-tags.latest`, respects check interval, writes cache, handles network errors gracefully with 10s timeout.
- **Task 7 (installer):** ✅ `installer.ts` wraps `child_process.exec("pi install npm:@pi-unipi/unipi")` with 60s timeout, emits `UPDATE_APPLIED` or `UPDATE_ERROR` events.
- **Task 8 (changelog TUI):** ✅ `changelog-overlay.ts` has list/detail views, Current/New labels (teal/amber), j/k navigation, Enter for detail, Esc/q back, g/G jump.
- **Task 9 (readme TUI):** ✅ `readme-overlay.ts` has list/content views, `openDirect` parameter for arg mode, version display, markdown rendering.
- **Task 10 (update overlay):** ✅ `update-overlay.ts` shows version diff, changelog for newer versions, [Y] Update / [n] Skip, auto mode with countdown, skip-version persistence.
- **Task 11 (settings TUI):** ✅ `settings-overlay.ts` has interval radio (30min/1h/6h/1d) and auto-update radio (disabled/notify/auto), Space cycles, Enter saves, Esc cancels.
- **Task 12 (commands):** ✅ `commands.ts` registers all 3 commands. Autocomplete entries in `constants.ts` with COMMAND_REGISTRY, COMMAND_DESCRIPTIONS, PACKAGE_ORDER, PACKAGE_COLORS, PACKAGE_LABELS.
- **Task 13 (entry point):** ✅ `src/index.ts` has `session_start` lifecycle (config load, update check, overlay show), `resources_discover` for skills, `registerCommands()`, `MODULE_READY` event.
- **Task 14 (CHANGELOG/README):** ✅ Root `CHANGELOG.md` exists with `[Unreleased]` section listing updater features, plus `[0.1.15]` and `[0.1.14]` entries. `packages/updater/README.md` exists.
- **Task 15 (integration):** ✅ Root `package.json` has `@pi-unipi/updater` dep, extension and skills entries. `packages/unipi/index.ts` imports and calls `updater(pi)`. Root README has updater row and 3 commands.
- **Task 16 (info-screen):** ✅ Info-screen group registered in `src/index.ts` with "updater" id, 4 stats (installed/latest/status/lastCheck), event subscriptions for reactive updates.
- **Task 17 (skill):** ✅ `skills/configure-updater/SKILL.md` documents all 3 commands, config options, cache behavior, and navigation keys.

Codebase Checks:
- ✓ Type check passed (`tsc --noEmit --skipLibCheck` — exit 0)
- ✓ Tests passed (180/180, 0 failures — workspace test scripts missing for web-api/workflow but all runnable tests pass)
- — Lint: no lint script defined
- — Build: no build script defined (pi-packages use TS directly)
- — Docker: no Dockerfile
