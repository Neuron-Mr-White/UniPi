# @pi-unipi/milestone

Lifecycle layer for project-level goals. Track progress across multiple workflow cycles via a `MILESTONES.md` file with automatic context injection and sync.

## Why

Workflow operates at the task level — brainstorm, plan, work, review. But project goals are scattered across specs, plans, and quick-work docs. Milestone provides a unified view of "what's left to do" and keeps the agent aligned with project goals across sessions.

## How It Works

1. **MILESTONES.md** — A markdown file with phases and checkbox items that tracks your project goals
2. **Session start hook** — Reads milestones and injects progress summary into the system prompt
3. **Session end hook** — Scans modified workflow docs, detects completed items, auto-updates milestones
4. **Coexist triggers** — Hooks into brainstorm/plan/consolidate to suggest milestone updates

## MILESTONES.md Format

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

## Skills

### `/unipi:milestone-onboard`

Create MILESTONES.md from existing workflow docs. Scans specs, plans, quick-work, debug, fix, and chore docs to group scattered tasks into coherent milestone phases.

**Phases:** Explore → Propose → Refine → Write → Report

### `/unipi:milestone-update`

Sync MILESTONES.md with completed work. Detects checkbox changes in workflow docs and updates milestone items.

**Phases:** Scan → Diff → Resolve → Write → Report

## API Exports

```typescript
import {
  parseMilestones,      // Parse MILESTONES.md → MilestoneDoc
  writeMilestones,      // Write MilestoneDoc → MILESTONES.md
  updateItemStatus,     // Toggle a checkbox item
  getProgressSummary,   // Get progress stats
} from "@pi-unipi/milestone";

import type {
  MilestoneDoc,
  MilestonePhase,
  MilestoneItem,
  ProgressSummary,
  PhaseProgress,
} from "@pi-unipi/milestone";
```

## Lifecycle Hooks

### Session Start

On `before_agent_start`, reads `.unipi/docs/MILESTONES.md` and appends a progress summary to the system prompt:

```
## Project Milestones
Overall progress: 5/10 items (50%)
  Phase 1: Foundation: 3/5 done
  Phase 2: Features: 2/5 done
Current focus: Phase 1: Foundation
```

If MILESTONES.md doesn't exist, no context is injected.

### Session End

On `session_shutdown`, scans workflow docs modified during the session. Detects items that changed from `- [ ]` to `- [x]` and auto-updates MILESTONES.md using exact text matching.

Unmatched items are logged as warnings — resolve manually with `/unipi:milestone-update`.

## Coexist Triggers

| Trigger | Behavior |
|---------|----------|
| After brainstorm | Checks if new spec items map to milestones, logs suggestions |
| After plan | Maps plan tasks to milestone items, logs coverage |
| After consolidate | References auto-sync from session shutdown |

All triggers are non-blocking and skip gracefully if MILESTONES.md doesn't exist.

## Info Screen

Registers a "Milestones" group in the info-screen dashboard showing:
- **Progress** — completed/total items with percentage
- **Current Phase** — phase name with per-phase breakdown
- **Remaining** — items left to complete

## Configuration

No configuration needed. Place MILESTONES.md at `.unipi/docs/MILESTONES.md` and the extension handles the rest.

## Dependencies

- `@pi-unipi/core` — shared constants and utilities
- `@mariozechner/pi-coding-agent` — extension API
- `@mariozechner/pi-tui` — TUI types
