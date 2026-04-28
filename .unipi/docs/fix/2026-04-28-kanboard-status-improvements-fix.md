---
title: "Kanboard Status Improvements — Quick Fix"
type: quick-fix
date: 2026-04-28
---

# Kanboard Status Improvements — Quick Fix

## Bug
1. Chores showed "in-progress" status incorrectly
2. Plans lacked "reviewed" status
3. Quick work displayed as "todo 0/0" even though it's a report (complete by definition)

## Root Cause
- `ItemStatus` type only had `todo | in-progress | done`
- Plan parser didn't recognize "reviewed" keyword
- Workflow page showed "todo" badge for any doc with 0 items, including quick-work reports

## Fix
1. Added "reviewed" to `ItemStatus` type
2. Updated plan parser to recognize "reviewed" status keyword
3. Updated workflow page to show "done" status for quick-work with no items
4. Added "Reviewed" filter button in workflow page
5. Updated all status badge components to display "reviewed" label

### Files Modified
- `packages/kanboard/types.ts` — Added `reviewed` to `ItemStatus` union
- `packages/kanboard/parser/plans.ts` — Added `reviewed` to status map and regex pattern
- `packages/kanboard/ui/workflow/page.ts` — 
  - Fixed 0-item status logic for quick-work
  - Added reviewed to done count calculations
  - Added reviewed filter button
  - Added reviewed status icon (◉)
- `packages/kanboard/ui/components/status-badge.ts` — Added reviewed label
- `packages/kanboard/ui/static/style.css` — Added badge-reviewed and checklist-status.reviewed styles

## Verification
- Typecheck passes: `npm run typecheck`
- Plans now support: unstarted, in-progress, completed, failed, awaiting_user, blocked, skipped, reviewed
- Quick work with no items shows "✓ Done" instead of "○ To Do"
- Reviewed items count as complete in progress calculations

## Notes
- "Reviewed" maps to "reviewed" ItemStatus (not converted to "done")
- Quick work is treated as a report - 0 items means it's complete by default
