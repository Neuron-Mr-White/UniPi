---
title: "Milestone & Kanboard Extensions"
type: brainstorm
date: 2026-04-28
---

# Milestone & Kanboard Extensions

## Problem Statement

Workflow operates at the task level — brainstorm a feature, plan it, build it. But tasks and checklists are **scattered** across brainstorm specs (`- [ ]` items), plan docs (`unstarted:` / `in-progress:` / `completed:`), quick-work summaries, debug/fix reports, and chore definitions. There is no unified view of "what's left to do" and no mechanism to track project-level progress across multiple workflow cycles.

Additionally, there's no way to define project-level phases/goals and have the agent automatically stay aligned with them across sessions.

## Context

**Existing system:**
- `@pi-unipi/workflow` provides 19 commands for task-level work (brainstorm → plan → work → review → consolidate)
- `@pi-unipi/info-screen` provides a dashboard with module registration
- `@pi-unipi/mcp` demonstrates TUI overlay patterns (split-pane, vim-modal)
- Docs are stored in `.unipi/docs/{specs,plans,quick-work,debug,fix,chore,reviews}/`
- Checkbox format: `- [ ]` / `- [x]` in specs; `unstarted:` / `in-progress:` / `completed:` in plans

**Gap:** No higher-level project tracking, no unified task view, no web visualization.

## Chosen Approach

Two separate packages:

1. **`@pi-unipi/milestone`** — Lifecycle layer for project-level goals
   - Hook-based: auto-read on session start, auto-sync on session end
   - MILESTONES.md format with phases and checkboxes
   - Skills for onboarding and updating milestones
   - Coexist triggers with workflow skills

2. **`@pi-unipi/kanboard`** — Visualization layer
   - Web server (Node http, port 8165+) with htmx + Alpine.js UI
   - Modular parsers for all workflow doc types
   - Two web pages: Milestones + Workflow
   - TUI overlay with two tabs: Tasks list + Kanban board
   - Copy-to-clipboard command shortcuts

## Why This Approach

**Milestone as hooks (not skill-only):** Milestones should be passive — the agent always knows the project's goals without the user remembering to invoke a command. Lifecycle hooks make this automatic.

**Kanboard as unified server (not per-page):** Parsing logic is shared across pages (both need to read specs, plans, etc.). A unified server avoids port conflicts and code duplication.

**Two packages (not one):** Milestone has standalone value (lifecycle hooks, MILESTONES.md management). Kanboard depends on milestone's data but adds visualization. Clean separation allows using milestone without kanboard.

**htmx + Alpine.js (not SPA):** No build step, server-rendered with partial updates. Easy to maintain, lightweight, reactive enough for this use case.

**Implicit links (not explicit):** Milestone auto-discovers connections between items and docs by scanning content. Simpler for the user — no manual linking required.

## Design

### Package 1: @pi-unipi/milestone

**Structure:**
```
packages/milestone/
├── index.ts                 # Extension entry — registers hooks, commands
├── commands.ts              # Command registration
├── milestone.ts             # MILESTONES.md read/write/parse logic
├── hooks.ts                 # Session start/end lifecycle hooks
├── types.ts                 # TypeScript interfaces
├── skills/
│   ├── milestone-onboard/
│   │   └── SKILL.md
│   └── milestone-update/
│       └── SKILL.md
├── package.json
└── README.md
```

**MILESTONES.md Format:**
```markdown
---
title: "Project Milestones"
created: 2026-04-28
updated: 2026-04-28
---

# Project Milestones

## Phase 1: Foundation
> Set up the core infrastructure

- [x] Project scaffold and build system
- [x] Database schema design
- [ ] Authentication system
- [ ] API routing layer

## Phase 2: Core Features
> Build the primary user-facing features

- [ ] User dashboard
- [ ] File upload system
- [ ] Notification service
```

- Phases are `##` headers with optional `>` description
- Items are `- [ ]` / `- [x]` checkboxes
- Links are implicit — system discovers connections by scanning docs
- Frontmatter tracks metadata

**Lifecycle Hooks:**

*Session Start:*
1. Check if `.unipi/docs/MILESTONES.md` exists
2. If yes, read and parse it
3. Inject summary as system context: "Project milestones: Phase 1 (3/5 done), Phase 2 (0/4 done). Current focus: Authentication system."
4. Agent starts every session knowing where the project stands

*Session End (before memory save):*
1. Scan all workflow docs modified in this session
2. Diff checkbox states: what changed from `- [ ]` to `- [x]`
3. Auto-update corresponding items in MILESTONES.md (unambiguous matches only)
4. If conflict detected (work done doesn't match any milestone item), use ask_user
5. Runs before memory consolidation so milestones are current

**Coexist Triggers with Workflow:**

| Workflow Skill | Enhancement |
|----------------|-------------|
| `brainstorm` | After spec written, check if items map to milestones, offer to update |
| `plan` | After plan created, auto-check milestone items covered by this plan |
| `work` | At session start, inject milestone context |
| `consolidate` | Reference milestone sync that already happened |

**API Exports:**
```typescript
parseMilestones(filePath: string): MilestoneDoc
writeMilestones(filePath: string, doc: MilestoneDoc): void
updateItemStatus(filePath: string, phaseName: string, itemText: string, status: boolean): void
getProgressSummary(filePath: string): ProgressSummary
```

**Info-Screen Registration:**
```typescript
infoRegistry.registerGroup({
  id: "milestone",
  name: "Milestones",
  icon: "🎯",
  priority: 40,
  config: {
    showByDefault: true,
    stats: [
      { id: "phase", label: "Current Phase", show: true },
      { id: "progress", label: "Progress", show: true },
      { id: "remaining", label: "Remaining", show: true },
    ],
  },
  dataProvider: async () => ({
    phase: { value: "Phase 2: Core Features" },
    progress: { value: "5/12", detail: "42% complete" },
    remaining: { value: "7 items", detail: "across 2 phases" },
  }),
});
```

### Package 2: @pi-unipi/kanboard

**Structure:**
```
packages/kanboard/
├── index.ts                 # Extension entry — registers commands
├── commands.ts              # Command registration
├── server/
│   ├── index.ts             # HTTP server, port allocation
│   ├── routes/
│   │   ├── milestone.ts     # Milestone page + API
│   │   ├── workflow.ts      # Workflow page + API
│   │   └── docs.ts          # CRUD API for doc items
│   └── middleware.ts        # Static files, error handling
├── parser/
│   ├── index.ts             # Unified parser interface
│   ├── specs.ts             # Brainstorm spec parser
│   ├── plans.ts             # Plan parser
│   ├── milestones.ts        # MILESTONES.md parser
│   ├── quick-work.ts        # Quick-work summary parser
│   ├── debug.ts             # Debug report parser
│   ├── fix.ts               # Fix report parser
│   ├── chore.ts             # Chore parser
│   └── reviews.ts           # Review parser
├── ui/
│   ├── layouts/
│   │   └── base.ts          # Shared HTML layout (htmx + Alpine)
│   ├── milestone/
│   │   └── page.ts          # Milestone page template
│   ├── workflow/
│   │   └── page.ts          # Workflow page template
│   ├── components/
│   │   ├── checklist.ts      # Reusable checklist component
│   │   ├── copy-button.ts    # Copy-to-clipboard command button
│   │   └── status-badge.ts   # Task status indicator
│   └── static/
│       ├── style.css         # Minimal CSS
│       └── app.js            # Alpine.js components
├── tui/
│   └── kanboard-overlay.ts  # TUI overlay (two tabs)
├── skills/
│   └── kanboard-doctor/
│       └── SKILL.md
├── package.json
└── README.md
```

**Server:**
- Node built-in `http` module (no Express)
- Port allocation: try 8165, increment on conflict (max 8175)
- PID file at `.unipi/kanboard.pid` to detect running instance
- Graceful shutdown on SIGINT/SIGTERM
- Serves static assets from `ui/static/`

**Parser Interface:**
```typescript
interface ParsedItem {
  text: string;
  status: "todo" | "in-progress" | "done";
  lineNumber: number;
  sourceFile: string;
  command?: string;  // Copy-to-clipboard command
}

interface ParsedDoc {
  type: "spec" | "plan" | "milestone" | "quick-work" | "debug" | "fix" | "chore" | "review";
  title: string;
  filePath: string;
  items: ParsedItem[];
  metadata: Record<string, string>;
}

interface DocParser {
  canParse(filePath: string): boolean;
  parse(filePath: string): ParsedDoc;
}
```

**Doc Types Parsed:**

| Doc Type | Location | What to Extract |
|----------|----------|-----------------|
| Brainstorm specs | `.unipi/docs/specs/` | `- [ ]` and `- [x]` checklist items |
| Plans | `.unipi/docs/plans/` | `unstarted:`, `in-progress:`, `completed:` task statuses |
| MILESTONES | `.unipi/docs/MILESTONES.md` | Phase headers + `- [ ]` items |
| Quick-work | `.unipi/docs/quick-work/` | Summary of what was done |
| Debug reports | `.unipi/docs/debug/` | Bug descriptions + status |
| Fix reports | `.unipi/docs/fix/` | What was fixed |
| Chores | `.unipi/docs/chore/` | Chore definitions |
| Reviews | `.unipi/docs/reviews/` | Review remarks |

**Web UI — Milestone Page:**
- Phases displayed as collapsible sections with progress bars
- Checklist items with status indicators
- Copy-to-clipboard buttons for related commands
- "Add Item" button → inline form, writes to MILESTONES.md
- Delete button with confirmation
- Alpine.js reactive filtering by phase/status

**Web UI — Workflow Page:**
- Cards grouped by doc type (specs, plans, quick-work, debug, fix, chores, reviews)
- Each card shows title, item count, completion status
- Click card → expanded view showing all items
- Copy-to-clipboard commands next to relevant items:
  - Specs: "📋 `/unipi:plan specs:...`"
  - Plans: "📋 `/unipi:work plan:...`"
  - Debug: "📋 `/unipi:fix debug:...`"
  - Chores: "📋 `/unipi:chore-execute chore:...`"

**TUI Overlay:**
- Tab 1: Tasks — flat list of all tasks from all docs, status indicators, j/k navigation
- Tab 2: Board — kanban columns (To Do / In Progress / Done) from plan statuses
- Key shortcuts: Tab switch, j/k navigate, Enter expand, q close
- Uses pi-tui overlay API (same pattern as MCP add overlay)

### Skills Design

All skills match the quality bar of brainstorm/plan/consolidate/debug:

**Boundaries:** Each skill has explicit MAY/MAY NOT boundaries
**Hard Gates:** No code writing during discussion skills
**Phases:** Clear exit criteria for each phase
**One question at a time:** Never dump questionnaires
**Propose approaches:** With trade-offs when decisions needed
**Validation checklist:** At the end of each skill

#### /unipi:milestone-onboard

Phases:
1. Explore — Scan existing workflow docs to understand what's been done
2. Propose — Suggest milestone phases based on existing work, grouped logically
3. Refine — User approves/adjusts phases, adds/removes items
4. Write — Save MILESTONES.md
5. Report — Show summary, suggest next steps

#### /unipi:milestone-update

Phases:
1. Scan — Read all workflow docs modified since last update
2. Diff — Compare checkbox states in docs vs. MILESTONES.md
3. Resolve — Auto-update clear matches, ask-user on conflicts
4. Write — Update MILESTONES.md
5. Report — Show what changed

#### /unipi:kanboard-doctor

Phases:
1. Run All Parsers — Execute each parser against its doc type
2. Collect Errors — Group by file with line numbers
3. Present Report — Show errors structured
4. Fix One by One — Suggest fix, ask user to confirm
5. Re-validate — Re-run parser after each fix

## Implementation Checklist

### @pi-unipi/core
- [x] Add milestone and kanboard constants to constants.ts (MODULES, COMMANDS, DIRS) — covered in milestone-plan Task 1 + kanboard-plan Task 1

### @pi-unipi/milestone
- [x] Create milestone package structure (package.json, index.ts, README.md) — covered in milestone-plan Task 1
- [x] Implement MILESTONES.md parser (parse, write, updateItemStatus) — covered in milestone-plan Task 3
- [x] Implement session start hook (read milestones, inject summary context) — covered in milestone-plan Task 4
- [x] Implement session end hook (scan docs, diff checkboxes, auto-sync) — covered in milestone-plan Task 5
- [x] Write milestone-onboard skill (SKILL.md with full phases) — covered in milestone-plan Task 7
- [x] Write milestone-update skill (SKILL.md with full phases) — covered in milestone-plan Task 8
- [x] Register milestone commands (milestone-onboard, milestone-update) — covered in milestone-plan Task 9
- [x] Add coexist triggers for workflow skills (brainstorm, plan, work, consolidate) — covered in milestone-plan Task 10
- [x] Register info-screen group for milestone stats — covered in milestone-plan Task 6
- [x] Add milestone command completions (suggest existing phases) — covered in milestone-plan Task 9
- [x] Test lifecycle hooks (session start/end) — covered in milestone-plan Task 12
- [x] Test coexist triggers (with and without workflow) — covered in milestone-plan Task 12

### @pi-unipi/kanboard
- [x] Create kanboard package structure (package.json, index.ts, README.md) — covered in kanboard-plan Task 1
- [x] Implement HTTP server with port allocation and PID management — covered in kanboard-plan Task 3
- [x] Implement parser interface and base types — covered in kanboard-plan Task 4
- [x] Implement brainstorm spec parser — covered in kanboard-plan Task 5
- [x] Implement plan parser — covered in kanboard-plan Task 6
- [x] Implement MILESTONES.md parser (reuse milestone package's parser) — covered in kanboard-plan Task 7
- [x] Implement quick-work parser — covered in kanboard-plan Task 8
- [x] Implement debug report parser — covered in kanboard-plan Task 8
- [x] Implement fix report parser — covered in kanboard-plan Task 8
- [x] Implement chore parser — covered in kanboard-plan Task 8
- [x] Implement review parser — covered in kanboard-plan Task 8
- [x] Build shared HTML layout with htmx + Alpine.js — covered in kanboard-plan Task 9
- [x] Build milestone web page (phases, progress bars, checklist, add/delete) — covered in kanboard-plan Task 10
- [x] Build workflow web page (cards by doc type, expand, copy commands) — covered in kanboard-plan Task 11
- [x] Build copy-to-clipboard component — covered in kanboard-plan Task 12
- [x] Build TUI overlay with two tabs (tasks list + kanban board) — covered in kanboard-plan Task 13
- [x] Write kanboard-doctor skill (SKILL.md) — covered in kanboard-plan Task 14
- [x] Register kanboard commands (kanboard, kanboard-doctor) — covered in kanboard-plan Task 15
- [x] Add command completions for kanboard — covered in kanboard-plan Task 15
- [x] Test server lifecycle (start, persist, stop) — covered in kanboard-plan Task 18
- [x] Test all parsers (happy path + malformed input) — covered in kanboard-plan Task 18
- [x] Test TUI overlay navigation — covered in kanboard-plan Task 18

### Documentation
- [x] Write README.md for @pi-unipi/milestone — covered in milestone-plan Task 11
- [x] Write README.md for @pi-unipi/kanboard — covered in kanboard-plan Task 17
- [x] Update workflow README.md to mention milestone integration — covered in milestone-plan Task 11
- [x] Add coexist-triggers documentation for milestone — covered in milestone-plan Task 11

## Open Questions — Resolved

These questions were resolved during planning:

1. **Session end detection:** Listen to `WORKFLOW_END` event from `@pi-unipi/core/events.ts`. No `onSessionEnd` hook exists — event-based is the correct pattern. Also expose manual `/unipi:milestone-update` as fallback. → **milestone-plan Task 5**

2. **File locking:** Optimistic write — write file, read back to verify. No external locking (single-agent + localhost web UI, low contention). → **milestone-plan Task 3**

3. **Parser resilience:** Collect warnings per file, surface in kanboard-doctor. Parsers return partial results — skip unparseable lines, log warnings, never throw. → **kanboard-plan Task 4-8**

4. **TUI ↔ Web server interaction:** TUI parses docs independently (no coupling to web server). Simpler, no HTTP dependency for TUI. → **kanboard-plan Task 13**

5. **Milestone auto-linking:** Exact text match first (normalized: lowercase, trimmed). If no exact match, skip auto-update and log warning. User resolves via `/unipi:milestone-update` skill. → **milestone-plan Task 5, Task 10**

## Out of Scope

- **Real-time updates:** No WebSocket/SSE for live dashboard updates. Page refreshes on changes.
- **User authentication:** Web server is localhost only, no auth needed.
- **Mobile responsive:** Desktop-focused terminal tool, mobile layout not a priority.
- **Database storage:** All data is file-based (markdown docs). No SQLite or external DB.
- **Task assignment:** No concept of who is responsible for a task.
- **Due dates:** No deadline tracking in this version.
- **Export/import:** No CSV, JSON export of milestone data.
