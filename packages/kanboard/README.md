# @pi-unipi/kanboard

Visualization for workflow data. An HTTP server with htmx + Alpine.js UI shows your milestones, specs, plans, and tasks in a web browser. A TUI overlay gives you a kanban board without leaving Pi.

Parses 8 document types from `.unipi/docs/` — specs, plans, milestones, quick-work, debug, fix, chore, and review — and renders them as cards with progress indicators.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:kanboard` | Toggle kanboard server on/off |
| `/unipi:kanboard-doctor` | Diagnose and fix parser issues |

## Web Pages

### Milestones (`/`)
- Phases with progress bars
- Checklist items with status indicators (done/todo)
- Collapsible sections per phase

### Workflow (`/workflow`)
- Cards grouped by document type
- Progress indicators per card
- Filtering by status (All, To Do, In Progress, Done)

## TUI Overlay

Two tabs accessible via the kanboard overlay:

- **Tasks** — Flat list of all tasks from all documents with status icons
- **Board** — Kanban columns (To Do / In Progress / Done)

### Controls

| Key | Action |
|-----|--------|
| `j/k` | Navigate up/down |
| `h/l` | Switch columns (Board tab) |
| `Tab` or `b` | Switch between Tasks/Board tabs |
| `t` | Switch to Tasks tab |
| `gg/G` | Jump to top/bottom |
| `q/Esc` | Close overlay |

## Special Triggers

Kanboard registers with the info-screen dashboard, showing document count, tasks done, total tasks, and completion percentage. The footer subscribes to kanboard registry data to display task stats in the status bar.

## Parser System

Kanboard parses 8 document types:

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

Parsers are resilient — they collect warnings per file and return partial results. Warnings are surfaced in the kanboard-doctor skill.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Milestone page |
| GET | `/workflow` | Workflow page |
| GET | `/api/milestones` | Milestone JSON data |
| GET | `/api/workflow` | Workflow JSON data |
| POST | `/api/docs/:type/:file/items/:line` | Update item status |

## Configurables

Default port configuration from `@pi-unipi/core`:

```typescript
KANBOARD_DEFAULTS = {
  PORT: 8165,      // Starting port
  MAX_PORT: 8175,  // Maximum port to try
}
```

- Port allocation: tries 8165, increments on EADDRINUSE
- PID file: `.unipi/kanboard.pid`
- Graceful shutdown on SIGINT/SIGTERM

## License

MIT
