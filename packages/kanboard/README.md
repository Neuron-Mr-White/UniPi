# @pi-unipi/kanboard

Visualization layer for unipi workflow data. Kanboard provides an HTTP server with htmx + Alpine.js UI, modular parsers for all workflow document types, two web pages (Milestones + Workflow), a TUI overlay with tasks list and kanban board, and a doctor skill for parser diagnostics.

## Quick Start

```bash
# Start the kanboard server
/unipi:kanboard

# Diagnose parser issues
/unipi:kanboard-doctor
```

## Architecture

```
kanboard/
├── server/          # HTTP server with port allocation
│   ├── index.ts     # Server core (KanboardServer class)
│   └── routes/      # Route handlers (milestone, workflow)
├── parser/          # Document parsers
│   ├── index.ts     # ParserRegistry + createDefaultRegistry()
│   ├── specs.ts     # Spec parser (checklist items)
│   ├── plans.ts     # Plan parser (task statuses)
│   ├── milestones.ts # Milestone parser
│   └── remaining.ts # Quick-work, debug, fix, chore, review
├── ui/              # Web UI
│   ├── layouts/     # Base HTML layout
│   ├── static/      # CSS + JS (style.css, app.js)
│   ├── components/  # Reusable components
│   ├── milestone/   # Milestone page renderer
│   └── workflow/    # Workflow page renderer
├── tui/             # TUI overlay
│   └── kanboard-overlay.ts
├── skills/          # Skills
│   └── kanboard-doctor/ # Parser diagnostics
├── commands.ts      # Command registration
├── types.ts         # Shared TypeScript types
└── index.ts         # Extension entry point
```

## Web Pages

### Milestones (`/`)
- Displays MILESTONES.md phases with progress bars
- Checklist items with status indicators (✓ done, ○ todo)
- Collapsible sections per phase
- Copy-to-clipboard for `/unipi:milestone-update`

### Workflow (`/workflow`)
- Cards grouped by document type (specs, plans, fixes, etc.)
- Progress indicators per card
- Alpine.js filtering by status (All, To Do, In Progress, Done)
- Copy-to-clipboard for relevant commands

## TUI Overlay

Two tabs accessible via the kanboard overlay:

- **Tasks** — Flat list of all tasks from all documents with status icons
- **Board** — Kanban columns (To Do / In Progress / Done)

### Controls
- `j/k` — Navigate up/down
- `h/l` — Switch columns (Board tab)
- `Tab` or `b` — Switch between Tasks/Board tabs
- `t` — Switch to Tasks tab
- `gg/G` — Jump to top/bottom
- `q/Esc` — Close overlay

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Milestone page |
| GET | `/workflow` | Workflow page |
| GET | `/api/milestones` | Milestone JSON data |
| GET | `/api/workflow` | Workflow JSON data |
| POST | `/api/docs/:type/:file/items/:line` | Update item status |

## Parser System

Kanboard parses 8 document types from `.unipi/docs/`:

| Type | Directory | What's Parsed |
|------|-----------|---------------|
| Spec | `specs/` | `- [ ]` / `- [x]` checklist items |
| Plan | `plans/` | `unstarted:` / `in-progress:` / `completed:` statuses |
| Milestone | `MILESTONES.md` | Phase headers + checklist items |
| Quick-work | `quick-work/` | Title + checklist items |
| Debug | `debug/` | Headers + checklists |
| Fix | `fix/` | Headers + checklists + related debug ref |
| Chore | `chore/` | Chore steps as checklist items |
| Review | `reviews/` | Review remarks as checklist items |

### Parser Warnings

Parsers are resilient — they collect warnings per file and return partial results:
- Empty checkbox text
- Malformed checkboxes
- Missing frontmatter
- Unparseable lines

Warnings are surfaced in the kanboard-doctor skill.

## Doctor Skill

The `kanboard-doctor` skill runs all parsers and produces a diagnostic report:

1. **Run All Parsers** — Parse every document
2. **Collect Errors** — Group warnings by file
3. **Present Report** — Structured error listing
4. **Fix One by One** — Suggest fixes, ask user to confirm
5. **Re-validate** — Re-run parser after each fix

## Server Configuration

Default configuration (from `@pi-unipi/core`):

```typescript
KANBOARD_DEFAULTS = {
  PORT: 8165,      // Starting port
  MAX_PORT: 8175,  // Maximum port to try
}
```

- Port allocation: tries 8165, increments on EADDRINUSE
- PID file: `.unipi/kanboard.pid`
- Graceful shutdown on SIGINT/SIGTERM
- Static files served from `ui/static/`

## Dependencies

- `@pi-unipi/core` — Shared constants and utilities
- `@mariozechner/pi-coding-agent` — Extension API
- `@mariozechner/pi-tui` — TUI overlay API
