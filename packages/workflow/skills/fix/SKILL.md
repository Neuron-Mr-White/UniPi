---
name: fix
description: "Fix bugs using debug reports. Autocomplete for debug files. Records fixes in docs/fix/."
---

# Fixing Bugs

Implement fixes based on debug reports. Autocomplete available for debug file selection.

## Boundaries

**This skill MAY:** read/write code, run tests, commit, write fix report to `.unipi/docs/fix/`.
**This skill MAY NOT:** create worktrees, merge branches, deploy.

## Command Format

```
/unipi:fix debug:<path>(optional) <string(greedy)>(optional)
```

- `debug:<path>` — debug report to fix from (autocomplete available)
- `string(greedy)` — optional scope or additional context
- If no debug provided → agent lists available debug reports and asks
- Full read/write sandbox

## Output Path

```
.unipi/docs/fix/YYYY-MM-DD-<topic>-fix.md
```

---

## Process

### Phase 1: Load Debug Report

**If `debug:` arg provided:**
1. Read the debug report from `.unipi/docs/debug/`
2. Understand: root cause, affected files, suggested fix, verification plan

**If no debug provided:**
1. List available debug reports in `.unipi/docs/debug/`
2. Present to user for selection (autocomplete-style)
3. Or ask if fixing without debug report (→ suggest `/unipi:quick-fix`)

**Exit:** Debug report loaded, fix strategy clear.

### Phase 2: Plan the Fix

Based on debug report:

1. Review suggested fix strategy
2. Identify all files that need changes
3. Plan the order of changes
4. Consider side effects

If debug report is unclear or incomplete:
> "Debug report suggests {approach}, but I need to verify {aspect}. Should I investigate further or proceed with the suggested fix?"

**Exit:** Fix plan ready.

### Phase 3: Implement Fix

1. Make the code changes as suggested in debug report
2. Follow the fix strategy step by step
3. If strategy doesn't work:
   - Document what happened
   - Try alternative approach
   - Update debug report if root cause was wrong

4. After each change:
   - Verify it compiles/parses
   - Check for immediate regressions

**Exit:** Code changes made.

### Phase 4: Verify Fix

Run verification as specified in debug report:

1. **Reproduce original bug** — confirm it no longer occurs
2. **Run test cases** — from debug report's verification plan
3. **Run project tests** — `npm test` or equivalent
4. **Check for regressions** — related functionality still works

If verification fails:
- Go back to Phase 3
- Update debug report with new findings
- Try alternative fix approach

**Exit:** Fix verified.

### Phase 5: Write Fix Report

Write to `.unipi/docs/fix/YYYY-MM-DD-<topic>-fix.md`:

```markdown
---
title: "{Bug Title} — Fix Report"
type: fix
date: YYYY-MM-DD
debug-report: {path-to-debug-report}
status: {fixed|partial-fix|could-not-fix}
---

# {Bug Title} — Fix Report

## Summary
{One-line description of what was fixed}

## Debug Report Reference
- Report: `.unipi/docs/debug/{filename}`
- Root Cause: {brief summary}

## Changes Made

### Files Modified
- `{file}` — {what changed and why}
- `{file}` — {what changed and why}

### Code Changes
{Key code changes, or "See git diff for details"}

## Fix Strategy
{How the fix addresses the root cause}

1. {Step 1}
2. {Step 2}

## Verification

### Test Results
- ✓ Original bug no longer reproduces
- ✓ Test case 1: {description}
- ✓ Test case 2: {description}
- ✓ Project tests pass

### Regression Check
- ✓ {Related feature 1} still works
- ✓ {Related feature 2} still works

## Risks & Mitigations
- {Risk}: {mitigation}

## Notes
{Any additional context, gotchas, or follow-ups}

## Follow-up
- [ ] {Optional follow-up task}
```

### Phase 6: Commit & Report

1. Commit changes with descriptive message
2. Report to user:

> "Fixed. Changes committed."
> 
> **Fix:** {brief summary}
> **Files:** {list of changed files}
> **Report:** `.unipi/docs/fix/YYYY-MM-DD-<topic>-fix.md`

Suggest next steps:

**If fix was straightforward:**
```
/unipi:consolidate
```

**If fix revealed deeper issues:**
> "The fix works, but I noticed {issue}. Consider:"
```
/unipi:scan-issues focus on {area}
```

**If fix was complex:**
> "This was a tricky fix. Consider documenting the pattern:"
```
/unipi:document {area}
```

---

## Autocomplete Behavior

When user types `/unipi:fix debug:`, autocomplete shows:

```
Available debug reports:
┌─────────────────────────────────────────┬────────────┬──────────────┐
│ File                                    │ Date       │ Status       │
├─────────────────────────────────────────┼────────────┼──────────────┤
│ 2026-04-28-auth-timeout-debug.md        │ 2026-04-28 │ root-caused  │
│ 2026-04-27-login-crash-debug.md         │ 2026-04-27 │ root-caused  │
│ 2026-04-26-slow-query-debug.md          │ 2026-04-26 │ needs-inv.   │
└─────────────────────────────────────────┴────────────┴──────────────┘
```

User selects one, or types path manually.

---

## Notes

- Debug reports are the primary input — they guide the fix
- Fixes without debug reports should use `/unipi:quick-fix` instead
- Always verify against the debug report's verification plan
- Fix reports provide audit trail for future reference
- If debug report's suggested fix doesn't work, document why and try alternatives
