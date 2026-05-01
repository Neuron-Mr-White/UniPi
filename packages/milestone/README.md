# @pi-unipi/milestone

Track project goals across workflow cycles. A `MILESTONES.md` file with phases and checkbox items that stays in sync with your specs, plans, and completed work.

Workflow operates at the task level — brainstorm, plan, work, review. Project goals scatter across those documents. Milestone gives you a single view of what's done and what's left, and keeps the agent aligned with your goals across sessions.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:milestone-onboard` | Create MILESTONES.md from existing workflow docs |
| `/unipi:milestone-update` | Sync MILESTONES.md with completed work |

## Special Triggers

### Session Start

On `before_agent_start`, milestone reads `.unipi/docs/MILESTONES.md` and appends a progress summary to the system prompt:

```
## Project Milestones
Overall progress: 5/10 items (50%)
  Phase 1: Foundation: 3/5 done
  Phase 2: Features: 2/5 done
Current focus: Phase 1: Foundation
```

If MILESTONES.md doesn't exist, no context is injected.

### Session End

On `session_shutdown`, milestone scans workflow docs modified during the session. Detects items that changed from `- [ ]` to `- [x]` and auto-updates MILESTONES.md using exact text matching.

### Coexist Triggers

| Trigger | Behavior |
|---------|----------|
| After brainstorm | Checks if new spec items map to milestones, logs suggestions |
| After plan | Maps plan tasks to milestone items, logs coverage |
| After consolidate | References auto-sync from session shutdown |

All triggers are non-blocking and skip gracefully if MILESTONES.md doesn't exist.

Milestone registers with the info-screen dashboard, showing progress, current phase, and remaining items.

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

## API Exports

```typescript
import {
  parseMilestones,      // Parse MILESTONES.md to MilestoneDoc
  writeMilestones,      // Write MilestoneDoc to MILESTONES.md
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

## Configurables

No configuration needed. Place MILESTONES.md at `.unipi/docs/MILESTONES.md` and the extension handles the rest.

## License

MIT
