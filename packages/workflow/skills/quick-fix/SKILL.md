---
name: quick-fix
description: "Fast bug fix without debug report. One-shot fix for clear, simple bugs. Records fixes in docs/fix/."
---

# Quick Fix

Fix simple bugs directly without requiring a debug report. One-shot execution for clear issues.

## Boundaries

**This skill MAY:** read/write code, run tests, commit, write fix report to `.unipi/docs/fix/`.
**This skill MAY NOT:** create worktrees, merge branches, deploy.

## Command Format

```
/unipi:quick-fix <string(greedy)>
```

- `string(greedy)` — bug description or error message
- Full read/write sandbox
- One shot — complete the fix in this session

## Output Path

```
.unipi/docs/fix/YYYY-MM-DD-<topic>-fix.md
```

---

## Process

### Phase 1: Understand the Bug

1. Read the bug description
2. If unclear, ask one clarifying question
3. Assess scope — is this truly a quick fix?
   - If complex → suggest `/unipi:debug` first
   - If appropriate → proceed

**Exit:** Bug understood, scoped as quick fix.

### Phase 2: Find and Fix

1. **Locate the bug:**
   - Search for error messages
   - Trace the code path
   - Find the problematic code

2. **Apply fix:**
   - Make the minimal correct change
   - Don't refactor unless necessary
   - Keep changes focused

3. **Verify:**
   - Confirm fix works
   - Run tests if applicable
   - Check for obvious regressions

**Exit:** Bug fixed.

### Phase 3: Write Fix Report

Write to `.unipi/docs/fix/YYYY-MM-DD-<topic>-fix.md`:

```markdown
---
title: "{Bug Title} — Quick Fix"
type: quick-fix
date: YYYY-MM-DD
---

# {Bug Title} — Quick Fix

## Bug
{Description of the bug}

## Root Cause
{Brief explanation of what was wrong}

## Fix
{What was changed and why}

### Files Modified
- `{file}` — {what changed}

## Verification
{How it was tested}

## Notes
{Anything worth noting}
```

### Phase 4: Commit & Report

1. Commit with descriptive message
2. Report to user:

> "Fixed. Changes committed. Report at `.unipi/docs/fix/YYYY-MM-DD-<topic>-fix.md`"

No further suggestions needed — this was a quick fix.

---

## When to Use quick-fix vs debug+fix

**Use quick-fix for:**
- Clear, obvious bugs
- Error messages that pinpoint the issue
- Simple logic errors
- Typos in code
- Missing null checks
- Wrong variable names

**Use debug+fix for:**
- Complex bugs with unclear root cause
- Intermittent issues
- Performance problems
- Bugs requiring deep investigation
- Issues affecting multiple systems

When in doubt, start with quick-fix. If it gets complex, suggest switching to debug.

---

## Notes

- No debug report required — direct fix
- Summary provides record of what was fixed
- For complex bugs, use `/unipi:debug` first
- Fix reports go to same `.unipi/docs/fix/` directory as regular fixes
