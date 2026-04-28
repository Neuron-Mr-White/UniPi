---
name: milestone-update
description: "Sync MILESTONES.md with completed work — scan docs, diff checkboxes, auto-update."
---

# Update Milestones

Sync MILESTONES.md with work completed in workflow docs. Detects checkbox changes and updates milestone items.

## Boundaries

**This skill MAY:** read `.unipi/docs/`, update `.unipi/docs/MILESTONES.md`, ask user for conflict resolution.
**This skill MAY NOT:** modify workflow docs, delete files, create new milestones (use `/unipi:milestone-onboard`).

---

## Phase 1: Scan

Read all workflow docs modified since last milestone update.

1. Read `.unipi/docs/MILESTONES.md` — if missing, suggest `/unipi:milestone-onboard`
2. Record `updated` date from MILESTONES.md frontmatter
3. Scan `.unipi/docs/{specs,plans,quick-work}/` for files modified after the `updated` date
4. If no modified files found:
   > "No workflow docs have been modified since the last milestone update."
5. List modified files and present to user

---

## Phase 2: Diff

Compare checkbox states between current docs and baseline.

1. For each modified file:
   - Extract all checkbox items (`- [ ]` and `- [x]`)
   - Extract task statuses from plans (`completed:`)
2. Compare against MILESTONES.md items:
   - **Exact match** (normalized): item text matches a milestone item
   - **No match**: item not found in milestones
3. Categorize:
   - **Newly completed**: item is `[x]` in doc but `[ ]` in milestones
   - **Already synced**: item matches milestone state
   - **Unmatched**: item not in milestones at all
4. Present diff:
   > "**Found 3 changes:**
   > - ✅ `Authentication system` — completed in spec.md (exact match)
   > - ✅ `API routing` — completed in plan.md (exact match)
   > - ⚠️ `New feature idea` — not found in milestones (skipped)"

---

## Phase 3: Resolve

Auto-update clear matches, ask user on conflicts.

1. **Exact matches**: Update automatically via `updateItemStatus()`
2. **Unmatched completions**: Present to user via `ask_user`:
   > "Found completed items not in milestones:
   > 1. `New feature idea` (from spec.md)
   >
   > What should I do?"
   > - Skip (don't update milestones)
   > - Add to a phase (specify which)
3. If user wants to add: ask which phase, then add item and mark as completed
4. Log all changes made

---

## Phase 4: Write

Apply resolved changes to MILESTONES.md.

1. For each resolved change:
   - Call `updateItemStatus(milestonesPath, phase, text, true)` for completions
   - Or modify doc directly for new items
2. Update `updated` frontmatter date to today
3. Verify file still parses correctly

---

## Phase 5: Report

Show what changed, what was skipped, suggest next steps.

1. Display summary:
   > "✅ **Milestones updated:**
   > - 2 items marked complete
   > - 1 item skipped (not in milestones)
   >
   > **Progress:** 5/10 items (50%)
   > **Current phase:** Phase 1: Foundation (3/5 done)
   >
   > **Next steps:**
   > - Continue with remaining items
   > - `/unipi:milestone-onboard` — restructure milestones"

2. If no changes were made:
   > "No milestone items needed updating. Everything is in sync."

---

## Validation Checklist

Before completing, verify:
- [ ] MILESTONES.md still exists and is valid
- [ ] All auto-updated items match their source docs
- [ ] `updated` date reflects today
- [ ] No items were accidentally unchecked
- [ ] File parses correctly via `parseMilestones()`
