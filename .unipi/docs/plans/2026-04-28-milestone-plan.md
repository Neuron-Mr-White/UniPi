---
title: "@pi-unipi/milestone — Implementation Plan"
type: plan
date: 2026-04-28
workbranch: feat/milestone
specs:
  - .unipi/docs/specs/2026-04-28-milestone-kanboard-design.md
---

# @pi-unipi/milestone — Implementation Plan

## Overview

Build the `@pi-unipi/milestone` package — a lifecycle layer for project-level goals. Milestones provide a `MILESTONES.md` file that tracks phases and items, session start hooks that inject progress context, session end hooks that auto-sync completed work, coexist triggers that enhance workflow skills, and two skills for onboarding and updating milestones.

This plan covers **only the milestone package**. Kanboard (visualization) is planned separately.

## Open Question Resolutions

| Question | Resolution |
|----------|-----------|
| Session end detection | Listen to `WORKFLOW_END` event from `@pi-unipi/core/events.ts`. Also expose a manual `/unipi:milestone-update` command as fallback. No `onSessionEnd` hook exists in pi — event-based is the correct pattern. |
| File locking | Optimistic write — write file, read back to verify. No external locking needed (single-agent + localhost web UI, low contention). |
| Milestone auto-linking | Exact text match first (normalized: lowercase, trimmed). If no exact match, skip auto-update and log warning. User resolves via `/unipi:milestone-update` skill. |

---

## Phase 1: Foundation (Package Scaffold + Core Parser)

### Task 1 — Package Scaffold + Constants
- **Status:** completed
- **Description:** Create `@pi-unipi/milestone` package directory, package.json, and add all constants to `@pi-unipi/core`.
- **Dependencies:** None
- **Acceptance Criteria:**
  - `packages/milestone/` exists with valid `package.json`
  - `packages/milestone/index.ts` exists (entry point)
  - `@pi-unipi/core/constants.ts` has `MILESTONE` in MODULES, `MILESTONE_COMMANDS`, `MILESTONE_DIRS`
  - `npx tsc --noEmit` passes
- **Steps:**
  1. Create `packages/milestone/package.json` following compactor/MCP pattern (pi-package keywords, peerDeps on pi-ai/pi-coding-agent/pi-tui, dep on @pi-unipi/core)
  2. Create `packages/milestone/index.ts` with empty extension entry stub
  3. Add `MILESTONE` to `MODULES` in `packages/core/constants.ts`
  4. Add `MILESTONE_COMMANDS` (milestone-onboard, milestone-update) to constants
  5. Add `MILESTONE_DIRS` (docs root, MILESTONES.md path) to constants
  6. Run typecheck

### Task 2 — Types
- **Status:** completed
- **Description:** Define TypeScript interfaces for milestone data structures.
- **Dependencies:** Task 1
- **Acceptance Criteria:**
  - `packages/milestone/types.ts` exports all shared interfaces
  - Types compile cleanly
- **Steps:**
  1. Create `packages/milestone/types.ts` with:
     - `MilestoneItem` — `{ text: string, checked: boolean, lineNumber: number }`
     - `MilestonePhase` — `{ name: string, description?: string, items: MilestoneItem[] }`
     - `MilestoneDoc` — `{ title: string, created: string, updated: string, phases: MilestonePhase[], filePath: string }`
     - `ProgressSummary` — `{ totalItems: number, completedItems: number, percentComplete: number, currentPhase: string, phases: Array<{ name: string, done: number, total: number }> }`
  2. Run typecheck

### Task 3 — MILESTONES.md Parser + Writer
- **Status:** completed
- **Description:** Implement parse, write, and updateItemStatus for MILESTONES.md files.
- **Dependencies:** Task 2
- **Acceptance Criteria:**
  - `parseMilestones(filePath)` correctly reads a MILESTONES.md file and returns `MilestoneDoc`
  - `writeMilestones(filePath, doc)` writes a valid MILESTONES.md file
  - `updateItemStatus(filePath, phaseName, itemText, checked)` toggles a checkbox
  - `getProgressSummary(filePath)` returns accurate stats
  - Handles missing file gracefully (returns empty doc)
  - Handles malformed input (skips unparseable lines, logs warning)
  - Unit tests pass
- **Steps:**
  1. Create `packages/milestone/milestone.ts`
  2. Implement `parseMilestones()`:
     - Read file, split lines
     - Parse frontmatter (title, created, updated)
     - Parse `## Phase N: Name` headers as phases
     - Parse `> description` lines as phase descriptions
     - Parse `- [ ]` / `- [x]` as items
     - Track line numbers for each item
  3. Implement `writeMilestones()`:
     - Generate frontmatter
     - For each phase: write `##` header, optional `>` description, checkbox items
     - Write to file atomically (write to temp, rename)
  4. Implement `updateItemStatus()`:
     - Parse file, find matching phase + item by normalized text
     - Toggle checkbox on that line number
     - Write back
  5. Implement `getProgressSummary()`:
     - Count total/completed items per phase and overall
     - Determine current phase (first phase with incomplete items)
  6. Write tests for each function (happy path + edge cases)

---

## Phase 2: Lifecycle Hooks

### Task 4 — Session Start Hook (Context Injection)
- **Status:** completed
- **Description:** On session start, read MILESTONES.md and inject a progress summary as system context.
- **Dependencies:** Task 3
- **Acceptance Criteria:**
  - Hook registers on extension load
  - Reads MILESTONES.md from `.unipi/docs/MILESTONES.md`
  - Injects context string: "Project milestones: Phase 1 (3/5 done), Phase 2 (0/4 done). Current focus: Authentication system."
  - Gracefully handles missing MILESTONES.md (no injection, no error)
  - Context injection is non-blocking
- **Steps:**
  1. Create `packages/milestone/hooks.ts`
  2. Implement `registerSessionStartHook()`:
     - Use `pi.events` or extension lifecycle to run on init
     - Call `parseMilestones()` and `getProgressSummary()`
     - Format summary string
     - Call `pi.context.addSystemContext()` or equivalent
  3. Register hook in `index.ts` extension entry
  4. Test: verify context appears when MILESTONES.md exists

### Task 5 — Session End Hook (Auto-Sync)
- **Status:** completed
- **Description:** Listen for `WORKFLOW_END` events, scan modified docs, diff checkboxes, auto-update MILESTONES.md.
- **Dependencies:** Task 3, Task 4
- **Acceptance Criteria:**
  - Listens to `UNIPI_EVENTS.WORKFLOW_END` from `@pi-unipi/core`
  - Scans `.unipi/docs/{specs,plans,quick-work}/` for files modified since session start
  - Diffs checkbox states: `- [ ]` → `- [x]` changes detected
  - Auto-updates MILESTONES.md for exact text matches only
  - Logs warnings for unmatched completions (doesn't auto-update fuzzy matches)
  - Updates `updated` frontmatter date
  - Doesn't crash if MILESTONES.md doesn't exist
- **Steps:**
  1. In `hooks.ts`, implement `registerSessionEndHook()`:
     - Track session start timestamp
     - Listen to `WORKFLOW_END` event
     - On event: scan docs directories for files modified after session start
     - Parse each modified file for checkbox changes
     - For each completed item, try exact match against MILESTONES.md items
     - Call `updateItemStatus()` for matches
  2. Implement doc scanner:
     - `scanModifiedDocs(dirs, since)` — returns list of modified files
     - `extractCheckboxChanges(filePath)` — returns items that changed from `[ ]` to `[x]`
  3. Register hook in `index.ts`
  4. Test: simulate WORKFLOW_END, verify MILESTONES.md updates

### Task 6 — Extension Entry + Registration
- **Status:** completed
- **Description:** Wire up the extension entry point to register hooks, commands, and info-screen group.
- **Dependencies:** Task 4, Task 5
- **Acceptance Criteria:**
  - `index.ts` exports a valid pi extension
  - Hooks are registered on extension load
  - Commands are registered (milestone-onboard, milestone-update)
  - Info-screen group is registered with stats provider
  - Extension loads without errors
- **Steps:**
  1. Implement `packages/milestone/index.ts`:
     - Import and call `registerSessionStartHook()`
     - Import and call `registerSessionEndHook()`
     - Import and call `registerCommands()`
     - Import and call `registerInfoScreenGroup()`
  2. Implement info-screen registration:
     - Group id: "milestone", name: "Milestones", icon: "🎯", priority: 40
     - Stats: current phase, progress (N/M), remaining items
     - `dataProvider` calls `getProgressSummary()`
  3. Test: extension loads, hooks fire, info-screen shows data

---

## Phase 3: Skills

### Task 7 — milestone-onboard Skill
- **Status:** completed
- **Description:** Write the `/unipi:milestone-onboard` skill for creating milestones from existing work.
- **Dependencies:** Task 6
- **Acceptance Criteria:**
  - `skills/milestone-onboard/SKILL.md` exists with full phases
  - Skill has proper boundaries (MAY/MAY NOT)
  - Phases: Explore → Propose → Refine → Write → Report
  - Explore phase scans existing workflow docs
  - Propose phase suggests milestone phases with trade-offs
  - Write phase saves MILESTONES.md via `writeMilestones()`
  - Validation checklist at end
- **Steps:**
  1. Create `packages/milestone/skills/milestone-onboard/SKILL.md`
  2. Write Phase 1 (Explore): Scan `.unipi/docs/` for existing specs, plans, quick-work, debug, fix, chore docs. List what's been done vs. what's planned.
  3. Write Phase 2 (Propose): Group findings into logical phases. Present with rationale. One question at a time.
  4. Write Phase 3 (Refine): User approves/adjusts phases, adds/removes items.
  5. Write Phase 4 (Write): Call `writeMilestones()` to save. Update frontmatter dates.
  6. Write Phase 5 (Report): Show summary, suggest `/unipi:milestone-update` for future sync.
  7. Add validation checklist

### Task 8 — milestone-update Skill
- **Status:** completed
- **Description:** Write the `/unipi:milestone-update` skill for syncing milestones with completed work.
- **Dependencies:** Task 6
- **Acceptance Criteria:**
  - `skills/milestone-update/SKILL.md` exists with full phases
  - Skill has proper boundaries (MAY/MAY NOT)
  - Phases: Scan → Diff → Resolve → Write → Report
  - Scan phase reads all workflow docs modified since last update
  - Diff phase compares checkbox states
  - Resolve phase auto-updates clear matches, asks user on conflicts
  - Validation checklist at end
- **Steps:**
  1. Create `packages/milestone/skills/milestone-update/SKILL.md`
  2. Write Phase 1 (Scan): Read all docs in `.unipi/docs/` directories. Filter by modification time.
  3. Write Phase 2 (Diff): Extract checkbox changes. Compare against MILESTONES.md items.
  4. Write Phase 3 (Resolve): Auto-update exact text matches. Present fuzzy/conflicting items to user via ask_user.
  5. Write Phase 4 (Write): Call `updateItemStatus()` for each resolved change. Update `updated` date.
  6. Write Phase 5 (Report): Show what changed, what was skipped, suggest next steps.
  7. Add validation checklist

### Task 9 — Command Registration + Completions
- **Status:** completed
- **Description:** Register milestone-onboard and milestone-update commands with completions.
- **Dependencies:** Task 7, Task 8
- **Acceptance Criteria:**
  - `commands.ts` registers both commands
  - Commands have proper descriptions
  - Completions suggest existing phase names from MILESTONES.md
  - Commands load skills from `skills/` directory
- **Steps:**
  1. Create `packages/milestone/commands.ts`
  2. Register `milestone-onboard` command with skill path
  3. Register `milestone-update` command with skill path
  4. Implement completions: read MILESTONES.md, extract phase names, suggest as args
  5. Wire commands into `index.ts`

---

## Phase 4: Coexist Triggers

### Task 10 — Workflow Coexist Triggers
- **Status:** completed
- **Description:** Add coexist triggers for brainstorm, plan, work, and consolidate skills.
- **Dependencies:** Task 6
- **Acceptance Criteria:**
  - After brainstorm: check if new spec items map to milestones, offer to update
  - After plan: auto-check milestone items covered by the plan
  - Work session start: inject milestone context (already done by hook, just verify)
  - Consolidate: reference milestone sync that already happened
  - Triggers are non-blocking and don't break workflow if milestone is missing
- **Steps:**
  1. Create `packages/milestone/coexist.ts`
  2. Implement `onBrainstormComplete(specPath)`:
     - Parse new spec for checklist items
     - Compare against MILESTONES.md items
     - If matches found, offer to mark as planned
  3. Implement `onPlanComplete(planPath)`:
     - Parse plan for task names
     - Compare against MILESTONES.md items
     - Auto-check items covered by plan
  4. Implement `onConsolidate()`:
     - Log milestone sync summary
  5. Register triggers via pi.events or extension hooks
  6. Test each trigger independently

---

## Phase 5: Polish

### Task 11 — README + Documentation
- **Status:** completed
- **Description:** Write README.md and update workflow documentation.
- **Dependencies:** All previous tasks
- **Acceptance Criteria:**
  - `packages/milestone/README.md` exists with usage, API, examples
  - Workflow README mentions milestone integration
  - Coexist triggers are documented
- **Steps:**
  1. Write `packages/milestone/README.md`:
     - What it does, why it exists
     - MILESTONES.md format
     - Skills overview (onboard, update)
     - API exports
     - Lifecycle hooks behavior
  2. Update `packages/workflow/README.md` to mention milestone integration
  3. Document coexist trigger behavior

### Task 12 — Integration Testing
- **Status:** completed
- **Description:** End-to-end test of the complete milestone workflow.
- **Dependencies:** All previous tasks
- **Acceptance Criteria:**
  - Create MILESTONES.md via onboard skill
  - Session start injects correct context
  - Complete a workflow task, session end auto-syncs milestone
  - Manual update skill works
  - Info-screen shows correct stats
  - All parsers handle edge cases
- **Steps:**
  1. Create test MILESTONES.md with 2 phases, 5 items each
  2. Verify session start hook injects summary
  3. Simulate completing items in a spec
  4. Trigger WORKFLOW_END, verify MILESTONES.md updated
  5. Run milestone-update skill, verify manual sync works
  6. Check info-screen output
  7. Test with missing MILESTONES.md (graceful degradation)
  8. Test with malformed MILESTONES.md (parser resilience)

---

## Sequencing

```
Task 1 (scaffold) → Task 2 (types) → Task 3 (parser)
                                         ↓
                                    Task 4 (start hook) → Task 5 (end hook) → Task 6 (entry)
                                                                                   ↓
                                                              ┌────────────────────┼────────────────────┐
                                                              ↓                    ↓                    ↓
                                                         Task 7               Task 8              Task 10
                                                    (onboard skill)      (update skill)        (coexist triggers)
                                                              ↓                    ↓
                                                              └────────┬───────────┘
                                                                       ↓
                                                                   Task 9
                                                              (commands + completions)
                                                                       ↓
                                                              ┌────────┴────────┐
                                                              ↓                 ↓
                                                         Task 11           Task 12
                                                          (docs)          (testing)
```

## Risks

1. **Session start hook mechanism** — Need to verify the exact API for injecting system context at extension load time. May need to use `pi.context` or a different mechanism.
2. **WORKFLOW_END event timing** — If the event fires before memory consolidation, milestone sync may conflict with consolidate's own tracking. Need to verify event ordering.
3. **Parser edge cases** — MILESTONES.md with unusual formatting (extra spaces, mixed indentation, non-standard headers) may cause parse failures. Mitigated by resilient parser design.
4. **Coexist trigger discovery** — Need to verify how pi extensions hook into other skills' completion events. May need a different pattern than expected.

---

## Reviewer Remarks

REVIEWER-REMARK: Done 11/12

- Tasks 1-10, 12: All acceptance criteria verified against implementation on `feat/milestone` branch
- Task 11 partially done: `packages/milestone/README.md` exists with usage, API, examples. But `packages/workflow/README.md` was NOT updated to mention milestone integration, and coexist triggers are not documented in the workflow README.

Task Verification:
- ✅ Task 1 (Scaffold + Constants): package.json, index.ts, MILESTONE/MILESTONE_COMMANDS/MILESTONE_DIRS in core/constants.ts, tsc --noEmit passes
- ✅ Task 2 (Types): types.ts exports MilestoneItem, MilestonePhase, MilestoneDoc, ProgressSummary, PhaseProgress
- ✅ Task 3 (Parser + Writer): parseMilestones, writeMilestones, updateItemStatus, getProgressSummary all implemented with 15 unit tests
- ✅ Task 4 (Session Start Hook): Uses `before_agent_start` to inject milestone progress into system prompt, handles missing file
- ✅ Task 5 (Session End Hook): Uses `session_shutdown`, captures baselines at session start, diffs checkbox states, auto-updates exact matches, logs warnings for unmatched
- ✅ Task 6 (Extension Entry): index.ts registers hooks, commands, info-screen group with stats provider
- ✅ Task 7 (Onboard Skill): Explore → Propose → Refine → Write → Report phases, boundaries, validation checklist
- ✅ Task 8 (Update Skill): Scan → Diff → Resolve → Write → Report phases, boundaries, validation checklist
- ✅ Task 9 (Commands): commands.ts registers both commands with phase-name completions from MILESTONES.md
- ✅ Task 10 (Coexist Triggers): onBrainstormComplete, onPlanComplete, onConsolidate — non-blocking when MILESTONES.md missing
- ⚠️ Task 11 (README): packages/milestone/README.md done, but workflow README not updated, coexist triggers not documented there
- ✅ Task 12 (Integration Tests): 8 integration tests covering lifecycle, malformed/missing files, atomic writes, roundtrip, case-insensitivity, 100% completion, doc scanning

Codebase Checks:
- ✓ Type check (tsc --noEmit) passed
- ✓ Tests passed: 23/23 (15 unit + 8 integration)
- ✗ Lint: no lint script configured
- ✗ Build: no build script configured (TS-only package, no build step needed)
