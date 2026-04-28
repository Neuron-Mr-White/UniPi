---
title: "@pi-unipi/kanboard — Implementation Plan"
type: plan
date: 2026-04-28
workbranch: feat/kanboard
specs:
  - .unipi/docs/specs/2026-04-28-milestone-kanboard-design.md
---

# @pi-unipi/kanboard — Implementation Plan

## Overview

Build the `@pi-unipi/kanboard` package — a visualization layer for unipi workflow data. Kanboard provides an HTTP server with htmx + Alpine.js UI, modular parsers for all workflow doc types, two web pages (Milestones + Workflow), a TUI overlay with tasks list and kanban board, and a doctor skill for parser diagnostics.

This plan depends on `@pi-unipi/milestone` being completed first (for MILESTONES.md parser reuse). Milestone is planned separately in `2026-04-28-milestone-plan.md`.

## Open Question Resolutions

| Question | Resolution |
|----------|-----------|
| Parser resilience | Collect warnings per file, surface in kanboard-doctor. Parsers return partial results — skip unparseable lines, log warnings, never throw. |
| TUI ↔ Web server | TUI parses docs independently (no coupling to web server). Simpler, no HTTP dependency for TUI. |

---

## Phase 1: Foundation (Package Scaffold + Server)

### Task 1 — Package Scaffold + Constants
- **Status:** completed
- **Description:** Create `@pi-unipi/kanboard` package directory, package.json, and add constants to `@pi-unipi/core`.
- **Dependencies:** None
- **Acceptance Criteria:**
  - `packages/kanboard/` exists with valid `package.json`
  - `packages/kanboard/index.ts` exists (entry point)
  - `@pi-unipi/core/constants.ts` has `KANBOARD` in MODULES, `KANBOARD_COMMANDS`, `KANBOARD_DIRS`, `KANBOARD_DEFAULTS`
  - `npx tsc --noEmit` passes
- **Steps:**
  1. Create `packages/kanboard/package.json` following compactor pattern
  2. Create `packages/kanboard/index.ts` with empty extension entry stub
  3. Add `KANBOARD` to `MODULES` in `packages/core/constants.ts`
  4. Add `KANBOARD_COMMANDS` (kanboard, kanboard-doctor) to constants
  5. Add `KANBOARD_DIRS` (static files, PID file) to constants
  6. Add `KANBOARD_DEFAULTS` (port: 8165, max port: 8175) to constants
  7. Run typecheck

### Task 2 — Types
- **Status:** completed
- **Description:** Define TypeScript interfaces for parser and server types.
- **Dependencies:** Task 1
- **Acceptance Criteria:**
  - `packages/kanboard/types.ts` exports all shared interfaces
  - Types compile cleanly
- **Steps:**
  1. Create `packages/kanboard/types.ts` with:
     - `ParsedItem` — `{ text: string, status: "todo" | "in-progress" | "done", lineNumber: number, sourceFile: string, command?: string }`
     - `ParsedDoc` — `{ type: DocType, title: string, filePath: string, items: ParsedItem[], metadata: Record<string, string>, warnings: string[] }`
     - `DocType` — `"spec" | "plan" | "milestone" | "quick-work" | "debug" | "fix" | "chore" | "review"`
     - `DocParser` — `{ canParse(filePath: string): boolean, parse(filePath: string): ParsedDoc }`
     - `KanboardConfig` — `{ port: number, maxPort: number, docsRoot: string, pidFile: string }`
  2. Run typecheck

### Task 3 — HTTP Server with Port Allocation
- **Status:** completed
- **Description:** Implement the HTTP server with port allocation, PID management, and graceful shutdown.
- **Dependencies:** Task 2
- **Acceptance Criteria:**
  - Server starts on port 8165, increments on conflict (max 8175)
  - PID file written to `.unipi/kanboard.pid`
  - Existing PID detected — warn and proceed (no duplicate kill)
  - Graceful shutdown on SIGINT/SIGTERM
  - Static file serving from `ui/static/`
  - Server responds on `GET /` with HTML
- **Steps:**
  1. Create `packages/kanboard/server/index.ts`
  2. Implement `startServer(config)`:
     - Try `http.createServer().listen(port)` on port 8165
     - On EADDRINUSE, try next port (up to 8175)
     - Write PID to `.unipi/kanboard.pid`
     - Install SIGINT/SIGTERM handlers for graceful close
  3. Implement `checkExistingInstance()`:
     - Read PID file, check if process exists
     - If running, log warning URL
  4. Implement static file middleware:
     - Serve `GET /static/*` from `ui/static/`
     - Content-type detection (css, js, html)
  5. Implement route registration:
     - `GET /` → milestone page
     - `GET /workflow` → workflow page
     - `GET /api/milestones` → milestone JSON
     - `GET /api/workflow` → workflow JSON
     - `POST /api/docs/:type/:file/items/:line` → update item status
  6. Test: start server, verify port allocation, verify PID file, verify shutdown

---

## Phase 2: Parsers

### Task 4 — Parser Interface + Registry
- **Status:** completed
- **Description:** Create the parser interface, registry, and base utilities.
- **Dependencies:** Task 2
- **Acceptance Criteria:**
  - `parser/index.ts` exports `ParserRegistry` class
  - Registry has `register(parser)`, `parse(filePath)`, `parseAll(dir)` methods
  - Auto-detects doc type by file path and content patterns
  - Returns `ParsedDoc[]` with warnings
- **Steps:**
  1. Create `packages/kanboard/parser/index.ts`
  2. Implement `ParserRegistry`:
     - `parsers: DocParser[]`
     - `register(parser)` — add to list
     - `parse(filePath)` — find matching parser, call parse, collect warnings
     - `parseAll(dir)` — glob for files, parse each, return all results
  3. Implement path-based type detection:
     - `specs/` → spec
     - `plans/` → plan
     - `MILESTONES.md` → milestone
     - `quick-work/` → quick-work
     - `debug/` → debug
     - `fix/` → fix
     - `chore/` → chore
     - `reviews/` → review
  4. Run typecheck

### Task 5 — Spec Parser
- **Status:** unstarted
- **Description:** Parse brainstorm specs for `- [ ]` / `- [x]` checklist items.
- **Dependencies:** Task 4
- **Acceptance Criteria:**
  - Parses `- [ ]` as todo, `- [x]` as done
  - Extracts title from frontmatter `title:` field
  - Tracks line numbers
  - Generates copy command: `/unipi:plan specs:{filename}`
  - Warns on malformed checkboxes (e.g., `- [ ]` with no text)
- **Steps:**
  1. Create `packages/kanboard/parser/specs.ts`
  2. Implement `SpecParser.canParse()` — check path contains `/specs/`
  3. Implement `SpecParser.parse()`:
     - Read file, parse frontmatter for title
     - Scan lines for `- [ ]` and `- [x]` patterns
     - Extract text after checkbox
     - Track line numbers
     - Generate command string
     - Collect warnings for malformed lines

### Task 6 — Plan Parser
- **Status:** unstarted
- **Description:** Parse plans for `unstarted:` / `in-progress:` / `completed:` task statuses.
- **Dependencies:** Task 4
- **Acceptance Criteria:**
  - Parses `unstarted:` as todo, `in-progress:` as in-progress, `completed:` as done
  - Extracts task name after status prefix
  - Tracks line numbers
  - Generates copy command: `/unipi:work plan:{filename}`
  - Handles `failed:`, `awaiting_user:`, `blocked:`, `skipped:` as special statuses
- **Steps:**
  1. Create `packages/kanboard/parser/plans.ts`
  2. Implement `PlanParser.canParse()` — check path contains `/plans/`
  3. Implement `PlanParser.parse()`:
     - Read file, parse frontmatter for title
     - Scan lines for status patterns: `(\s*- )?(unstarted|in-progress|completed|failed|awaiting_user|blocked|skipped):`
     - Map statuses: unstarted→todo, in-progress→in-progress, completed→done, failed→todo, awaiting_user→in-progress, blocked→in-progress, skipped→done
     - Extract task name (text after status prefix)
     - Track line numbers
     - Generate command string

### Task 7 — Milestone Parser
- **Status:** unstarted
- **Description:** Parse MILESTONES.md. Reuse `@pi-unipi/milestone` package's parser.
- **Dependencies:** Task 4, `@pi-unipi/milestone` package (Task 3 from milestone plan)
- **Acceptance Criteria:**
  - Imports `parseMilestones` from `@pi-unipi/milestone`
  - Converts `MilestoneDoc` to `ParsedDoc` format
  - Maps phase items to `ParsedItem[]`
  - Generates copy command: `/unipi:milestone-update`
- **Steps:**
  1. Create `packages/kanboard/parser/milestones.ts`
  2. Import `parseMilestones` from `@pi-unipi/milestone`
  3. Implement `MilestoneParser.parse()`:
     - Call `parseMilestones(filePath)`
     - Convert phases → items with status mapping (checked→done, unchecked→todo)
     - Generate command string
  4. Add `@pi-unipi/milestone` as dependency in package.json

### Task 8 — Remaining Parsers (quick-work, debug, fix, chore, review)
- **Status:** unstarted
- **Description:** Implement parsers for the remaining doc types.
- **Dependencies:** Task 4
- **Acceptance Criteria:**
  - Each parser has `canParse()` and `parse()` methods
  - Quick-work: extract summary text from frontmatter or first paragraph
  - Debug: extract bug description, status from headers
  - Fix: extract what was fixed, related debug reference
  - Chore: extract chore name, steps
  - Review: extract review remarks, status
  - All parsers handle missing/malformed files gracefully
  - All parsers generate appropriate copy commands
- **Steps:**
  1. Create `packages/kanboard/parser/quick-work.ts`:
     - Parse frontmatter title, extract `- [ ]`/`- [x]` items if present
     - Generate command: `/unipi:quick-work`
  2. Create `packages/kanboard/parser/debug.ts`:
     - Extract title, status (open/fixed)
     - Generate command: `/unipi:fix debug:{filename}`
  3. Create `packages/kanboard/parser/fix.ts`:
     - Extract title, related debug file
     - Generate command: `/unipi:fix debug:{related}`
  4. Create `packages/kanboard/parser/chore.ts`:
     - Extract chore name, steps as items
     - Generate command: `/unipi:chore-execute chore:{filename}`
  5. Create `packages/kanboard/parser/reviews.ts`:
     - Extract review title, remarks as items
     - Generate command: `/unipi:review-work`
  6. Register all parsers in registry
  7. Test each parser with sample files

---

## Phase 3: Web UI

### Task 9 — Shared HTML Layout
- **Status:** unstarted
- **Description:** Build the base HTML layout with htmx + Alpine.js.
- **Dependencies:** Task 3
- **Acceptance Criteria:**
  - `ui/layouts/base.ts` exports a function returning full HTML string
  - Includes htmx CDN, Alpine.js CDN
  - Navigation bar with links to Milestones and Workflow pages
  - Responsive layout (flexbox/grid)
  - Clean, readable design
- **Steps:**
  1. Create `packages/kanboard/ui/layouts/base.ts`
  2. Implement `renderLayout(title, content, activePage)`:
     - DOCTYPE html, head with meta, title, htmx/Alpine CDN links, style.css link
     - Body with nav bar (Milestones, Workflow links)
     - Main content area
     - Footer with "Powered by @pi-unipi/kanboard"
  3. Create `packages/kanboard/ui/static/style.css`:
     - Base styles (fonts, colors, spacing)
     - Card styles, checklist styles, progress bar styles
     - Navigation styles
     - Status badge styles
  4. Create `packages/kanboard/ui/static/app.js`:
     - Alpine.js data components for filtering
     - Copy-to-clipboard function
     - Collapsible section toggles

### Task 10 — Milestone Web Page
- **Status:** unstarted
- **Description:** Build the milestone page with phases, progress bars, and checklists.
- **Dependencies:** Task 7, Task 9
- **Acceptance Criteria:**
  - Phases displayed as collapsible sections
  - Progress bar per phase showing done/total
  - Checklist items with status indicators (✓ done, ○ todo)
  - Copy-to-clipboard button for `/unipi:milestone-update`
  - "Add Item" button with inline form (writes to MILESTONES.md)
  - Delete button with confirmation
  - htmx partial updates on item toggle
- **Steps:**
  1. Create `packages/kanboard/ui/milestone/page.ts`
  2. Implement `renderMilestonePage(docs)`:
     - Parse MILESTONES.md
     - Render each phase as collapsible section
     - Progress bar per phase
     - Checklist items with toggle buttons (htmx POST to update)
     - Copy command button
     - Add item form (Alpine.js reactive)
  3. Create `packages/kanboard/server/routes/milestone.ts`:
     - `GET /` → render full page
     - `GET /api/milestones` → JSON data
     - `POST /api/milestones/items` → add item
     - `PUT /api/milestones/items/:phase/:line` → toggle item
     - `DELETE /api/milestones/items/:phase/:line` → delete item

### Task 11 — Workflow Web Page
- **Status:** unstarted
- **Description:** Build the workflow page with cards grouped by doc type.
- **Dependencies:** Task 4-8 (parsers), Task 9
- **Acceptance Criteria:**
  - Cards grouped by doc type (specs, plans, quick-work, debug, fix, chores, reviews)
  - Each card shows title, item count, completion status
  - Click card → expanded view showing all items
  - Copy-to-clipboard commands next to relevant items
  - Alpine.js filtering by status
- **Steps:**
  1. Create `packages/kanboard/ui/workflow/page.ts`
  2. Implement `renderWorkflowPage(docs)`:
     - Group parsed docs by type
     - Render each group as section with card grid
     - Each card shows title, progress indicator, expand toggle
     - Expanded view shows all items with status badges
     - Copy command buttons
  3. Create `packages/kanboard/server/routes/workflow.ts`:
     - `GET /workflow` → render full page
     - `GET /api/workflow` → JSON data

### Task 12 — Copy-to-Clipboard Component
- **Status:** unstarted
- **Description:** Reusable copy button component for command shortcuts.
- **Dependencies:** Task 9
- **Acceptance Criteria:**
  - Renders a button that copies text to clipboard
  - Shows "Copied!" feedback for 2 seconds
  - Styled consistently
  - Works with Alpine.js
- **Steps:**
  1. Create `packages/kanboard/ui/components/copy-button.ts`
  2. Implement `renderCopyButton(text, label)`:
     - Button element with Alpine.js `@click` handler
     - `navigator.clipboard.writeText()` call
     - Visual feedback (icon change, tooltip)
  3. Create `packages/kanboard/ui/components/checklist.ts`:
     - Reusable checklist renderer
     - Status indicators, toggle buttons
  4. Create `packages/kanboard/ui/components/status-badge.ts`:
     - Badge with color coding (green=done, yellow=in-progress, gray=todo)

---

## Phase 4: TUI Overlay

### Task 13 — TUI Overlay (Tasks List + Kanban Board)
- **Status:** unstarted
- **Description:** Build the TUI overlay with two tabs: tasks list and kanban board.
- **Dependencies:** Task 4-8 (parsers)
- **Acceptance Criteria:**
  - Tab 1: Tasks — flat list of all tasks from all docs, status indicators, j/k navigation
  - Tab 2: Board — kanban columns (To Do / In Progress / Done) from plan statuses
  - Tab switching with Tab key
  - j/k navigation, Enter to expand, q to close
  - Uses pi-tui overlay API (same pattern as MCP add overlay)
- **Steps:**
  1. Create `packages/kanboard/tui/kanboard-overlay.ts`
  2. Implement `showKanboardOverlay()`:
     - Parse all docs using parser registry
     - Render two tabs using pi-tui overlay API
  3. Implement Tasks tab:
     - Flat list of all `ParsedItem` from all docs
     - Status icons (✓ done, ◐ in-progress, ○ todo)
     - Source file indicator
     - j/k to navigate, Enter to expand details
  4. Implement Board tab:
     - Three columns: To Do, In Progress, Done
     - Items distributed by status
     - Column headers with counts
     - j/k to navigate within column, h/l to switch columns
  5. Register overlay trigger in commands

---

## Phase 5: Skills + Commands

### Task 14 — kanboard-doctor Skill
- **Status:** unstarted
- **Description:** Write the kanboard-doctor skill for parser diagnostics.
- **Dependencies:** Task 4-8 (parsers)
- **Acceptance Criteria:**
  - `skills/kanboard-doctor/SKILL.md` exists with full phases
  - Phases: Run All Parsers → Collect Errors → Present Report → Fix One by One → Re-validate
  - Non-destructive — only suggests fixes, asks user to confirm
- **Steps:**
  1. Create `packages/kanboard/skills/kanboard-doctor/SKILL.md`
  2. Write Phase 1 (Run All Parsers): Execute each parser against its doc type directory
  3. Write Phase 2 (Collect Errors): Group warnings/errors by file with line numbers
  4. Write Phase 3 (Present Report): Show structured error report
  5. Write Phase 4 (Fix One by One): Suggest fix, ask user to confirm, apply fix
  6. Write Phase 5 (Re-validate): Re-run parser after each fix, verify error resolved

### Task 15 — Command Registration + Completions
- **Status:** unstarted
- **Description:** Register kanboard and kanboard-doctor commands.
- **Dependencies:** Task 14
- **Acceptance Criteria:**
  - `commands.ts` registers both commands
  - `kanboard` command starts server and opens browser (or shows URL)
  - `kanboard-doctor` command loads doctor skill
  - Completions suggest available doc types
- **Steps:**
  1. Create `packages/kanboard/commands.ts`
  2. Register `kanboard` command:
     - Start server (or detect running instance)
     - Show URL in output
  3. Register `kanboard-doctor` command with skill path
  4. Implement completions: suggest doc types as args
  5. Wire commands into `index.ts`

### Task 16 — Extension Entry + Registration
- **Status:** unstarted
- **Description:** Wire up the extension entry point.
- **Dependencies:** Task 13, Task 15
- **Acceptance Criteria:**
  - `index.ts` exports a valid pi extension
  - Commands are registered
  - Info-screen group registered with server status
  - Extension loads without errors
- **Steps:**
  1. Implement `packages/kanboard/index.ts`:
     - Import and call `registerCommands()`
     - Register info-screen group (server status, doc counts)
  2. Implement info-screen registration:
     - Group id: "kanboard", name: "Kanboard", icon: "📋", priority: 50
     - Stats: server status, URL, doc count, task count
  3. Test: extension loads, commands work

---

## Phase 6: Polish

### Task 17 — README + Documentation
- **Status:** unstarted
- **Description:** Write README.md documentation.
- **Dependencies:** All previous tasks
- **Acceptance Criteria:**
  - `packages/kanboard/README.md` exists with usage, architecture, examples
  - Documents all parsers, web pages, TUI overlay
  - Documents API endpoints
- **Steps:**
  1. Write `packages/kanboard/README.md`:
     - What it does, why it exists
     - Architecture overview (server, parsers, UI)
     - Web pages (milestone, workflow)
     - TUI overlay usage
     - API endpoints
     - Parser system
     - Doctor skill

### Task 18 — Integration Testing
- **Status:** unstarted
- **Description:** End-to-end test of the complete kanboard workflow.
- **Dependencies:** All previous tasks
- **Acceptance Criteria:**
  - Server starts and serves pages
  - All parsers produce correct output for sample docs
  - Web UI renders correctly, toggles work
  - TUI overlay navigates correctly
  - Doctor skill identifies and fixes issues
  - Handles missing docs gracefully
- **Steps:**
  1. Start server, verify port allocation
  2. Create sample docs of each type
  3. Verify each parser produces correct `ParsedDoc`
  4. Load web pages, verify rendering
  5. Toggle items via web UI, verify file updates
  6. Test TUI overlay navigation
  7. Run kanboard-doctor on malformed files
  8. Test with empty `.unipi/docs/` directory

---

## Sequencing

```
Task 1 (scaffold) → Task 2 (types) → Task 3 (server)
                                         ↓
                                    Task 4 (parser interface)
                                         ↓
                    ┌──────────┬─────────┼─────────┬──────────┐
                    ↓          ↓         ↓         ↓          ↓
                Task 5      Task 6    Task 7    Task 8    (parallel)
                (spec)      (plan)  (milestone) (rest)
                    ↓          ↓         ↓         ↓
                    └──────────┴─────────┴─────────┘
                                   ↓
                              Task 9 (layout)
                              ↓         ↓
                         Task 10     Task 11
                        (milestone   (workflow
                         page)        page)
                              ↓
                         Task 12 (copy button)
                              ↓
                         Task 13 (TUI overlay)
                              ↓
                         Task 14 (doctor skill)
                              ↓
                         Task 15 (commands)
                              ↓
                         Task 16 (entry)
                              ↓
                         Task 17 (docs)
                              ↓
                         Task 18 (testing)
```

## Risks

1. **Milestone package dependency** — Kanboard's milestone parser imports from `@pi-unipi/milestone`. If milestone isn't built yet, this parser won't compile. Mitigation: milestone plan should be completed first, or implement a fallback standalone parser.
2. **pi-tui overlay API** — Need to verify the exact API for creating TUI overlays. The MCP package uses this pattern but may have custom setup.
3. **htmx + Alpine.js CDN availability** — If the agent works offline, CDN resources won't load. Mitigation: bundle minimal copies in `ui/static/`.
4. **Port conflicts** — Port range 8165-8175 may conflict with other services. Mitigation: configurable port in KANBOARD_DEFAULTS.
5. **Parser complexity** — Eight different parsers, each with unique format assumptions. High maintenance burden. Mitigation: shared base parser with common regex patterns, kanboard-doctor skill for diagnostics.
