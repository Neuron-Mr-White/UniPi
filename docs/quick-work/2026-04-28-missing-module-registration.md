---
title: "Missing Module Registration"
type: quick-work
date: 2026-04-28
---

# Missing Module Registration

## Task
Check which modules are not registered in unipi, which should have all modules.

## Findings

### Issue 1: btw missing from MODULES constant
- **File:** `packages/core/constants.ts`
- **Problem:** `@pi-unipi/btw` was not defined in the MODULES constant, even though the package exists and is registered as an extension
- **Fix:** Added `BTW: "@pi-unipi/btw"` to the MODULES object

### Issue 2: Duplicate dependency
- **File:** `package.json`
- **Problem:** `@pi-unipi/notify` was listed twice in the dependencies section
- **Fix:** Removed the duplicate entry

### Issue 3: Orphaned MODULES entries (no action taken)
The following modules are defined in MODULES but have no corresponding package in `packages/`:
- `REGISTRY: "@pi-unipi/registry"`
- `TASK: "@pi-unipi/task"`
- `IMPECCABLE: "@pi-unipi/impeccable"`
- `SETTINGS: "@pi-unipi/settings"`

These may be planned modules or legacy entries. No changes made as they don't cause issues.

## Changes
- `packages/core/constants.ts`: Added `BTW: "@pi-unipi/btw"` to MODULES constant
- `package.json`: Removed duplicate `@pi-unipi/notify` from dependencies

## Verification
- Verified btw is now in MODULES constant
- Verified notify dependency is no longer duplicated
- Checked all 14 packages have correct registrations in pi.extensions and pi.skills

## Notes
- btw extension doesn't emit MODULE_READY event like other modules - may need future update
- The 4 orphaned MODULES entries (REGISTRY, TASK, IMPECCABLE, SETTINGS) should be reviewed - either create the packages or remove the entries
