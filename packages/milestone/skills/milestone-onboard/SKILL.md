---
name: milestone-onboard
description: "Create MILESTONES.md from existing workflow docs — scan, propose, refine, write."
---

# Onboard Milestones

Create a MILESTONES.md file by scanning existing workflow documentation. Groups scattered tasks into coherent milestone phases.

## Boundaries

**This skill MAY:** read `.unipi/docs/`, read existing specs/plans/quick-work/debug/fix/chore docs, write `.unipi/docs/MILESTONES.md`.
**This skill MAY NOT:** modify existing workflow docs, delete files, merge branches.

---

## Phase 1: Explore

Scan `.unipi/docs/` for existing workflow documentation. Understand what's been done and what's planned.

1. List all files in `.unipi/docs/{specs,plans,quick-work,debug,fix,chore}/`
2. For each file, extract:
   - Checkbox items (`- [ ]` and `- [x]`)
   - Task statuses (`unstarted:`, `in-progress:`, `completed:`)
   - File modification dates
3. Categorize findings:
   - **Completed work** — checked items, completed tasks
   - **In progress** — in-progress tasks, partially checked lists
   - **Planned** — unstarted tasks, unchecked items
4. Present summary to user:
   > "Found X completed items, Y in-progress, Z planned across N documents."

---

## Phase 2: Propose

Group findings into logical milestone phases. Present with rationale.

1. Analyze themes across documents — group related items together
2. Suggest 2-5 phases with clear names and descriptions
3. For each phase, list proposed items (both done and todo)
4. Present proposal:
   > "**Phase 1: Foundation** (3/5 done)
   > - [x] Project scaffold
   > - [x] Core parser
   > - [ ] Type definitions
   > - [ ] Error handling
   > - [ ] Documentation
   >
   > **Phase 2: Features** (0/3 done)
   > - [ ] User dashboard
   > - [ ] File upload
   > - [ ] Notifications
   >
   > Does this grouping look right?"

5. **One question at a time** — ask if phases are correct before proceeding

---

## Phase 3: Refine

User approves/adjusts phases. Iterate until satisfied.

1. If user wants changes:
   - **Add phase**: Ask for name and items
   - **Remove phase**: Confirm removal
   - **Move items**: Ask which item, which phase
   - **Rename phase**: Ask for new name
   - **Add items**: Ask for text and target phase
2. After each change, show updated proposal
3. Continue until user says "looks good" or "write it"

---

## Phase 4: Write

Save MILESTONES.md using the milestone parser.

1. Build `MilestoneDoc` from approved phases:
   - `title`: "Project Milestones" (or ask user for custom title)
   - `created`: today's date
   - `updated`: today's date
   - `phases`: approved phases with items
2. Call `writeMilestones(".unipi/docs/MILESTONES.md", doc)`
3. Verify file was written correctly

---

## Phase 5: Report

Show summary and suggest next steps.

1. Display what was written:
   > "✅ MILESTONES.md created with N phases and M items.
   > - Phase 1: Foundation (3/5 done)
   > - Phase 2: Features (0/3 done)
   >
   > **Next steps:**
   > - `/unipi:milestone-update` — sync milestones with completed work
   > - Milestones will auto-inject context on session start
   > - Completed items auto-sync on session end"

---

## Validation Checklist

Before completing, verify:
- [ ] MILESTONES.md exists at `.unipi/docs/MILESTONES.md`
- [ ] File has valid frontmatter (title, created, updated)
- [ ] All phases have names
- [ ] All items have checkbox format (`- [ ]` or `- [x]`)
- [ ] Previously completed items are marked `[x]`
- [ ] File parses correctly via `parseMilestones()`
