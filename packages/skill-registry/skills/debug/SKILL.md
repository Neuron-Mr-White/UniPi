---
name: debug
description: "Active bug investigation — reproduce, diagnose, root-cause analysis. Produces debug report for the fix step."
---

# Debugging

Active investigation to reproduce, diagnose, and root-cause bugs. Produces a structured debug report that `the fix step` can consume.

## Boundaries

**This skill MAY:** read codebase, run diagnostic commands, spawn subagents, write debug report to `docs/debug/`.
**This skill MAY NOT:** edit code, fix issues, run tests that modify state, deploy.

**Write-permission clarification:** "Read-only" means source/project code is read-only for diagnosis. It does **not** prohibit creating or updating the debug report. The agent should use available file-writing tools to write exactly the report under `docs/debug/`. If writing that report fails, report the write failure explicitly.

**This is diagnosis only — not fixing.**

## Command Format

```
the debug step <string(greedy)>
```

- `string(greedy)` — bug description, error message, or reproduction steps
- Source/code read-only sandbox, with explicit permission to write the debug report to `docs/debug/`
- Spawns subagents if `@unipi/subagents` extension is installed

## Output Path

```
docs/debug/YYYY-MM-DD-<topic>-debug.md
```

Create the `docs/debug/` folder if it does not exist yet — it is an ordinary project folder, not a unipi store.

---

## Process

### Phase 1: Understand the Bug

1. Read the bug description carefully
2. If unclear, ask clarifying questions (one at a time):
   - "What's the expected behavior?"
   - "What's the actual behavior?"
   - "Steps to reproduce?"
   - "When did this start happening?"
3. Identify the scope:
   - Single function/module
   - Integration issue
   - System-wide problem

**Exit:** Bug understood, scope defined.

### Phase 2: Reproduce

Attempt to reproduce the issue:

1. **Find reproduction path:**
   - Trace the code flow from entry point
   - Identify the failing code path
   - Look for error messages, stack traces

2. **Run diagnostic commands:**
   - `grep` for error messages in code
   - `find` related files
   - Check logs if available
   - Run read-only test commands if safe

3. **If subagents available:**
   - Spawn explore agents to trace different code paths in parallel
   - Each agent reports findings

**Exit:** Reproduction steps documented (or confirmed unreproducible).

### Phase 3: Diagnose

Deep dive into root cause:

1. **Trace the failure:**
   - Start from the error/symptom
   - Work backwards to find origin
   - Document each step in the chain

2. **Check common causes:**
   - Null/undefined values
   - Type mismatches
   - Race conditions
   - Missing error handling
   - Incorrect assumptions
   - Off-by-one errors
   - State corruption

3. **Analyze data flow:**
   - Input validation
   - Transformation steps
   - Output format
   - Edge cases

4. **Check dependencies:**
   - Recent changes to related code
   - External service issues
   - Configuration changes
   - Version mismatches

**Exit:** Root cause identified (or hypotheses listed if uncertain).

### Phase 4: Document Findings

Write debug report to `docs/debug/YYYY-MM-DD-<topic>-debug.md` using the available file-writing tool. Do not skip this because the investigation is otherwise read-only:

```markdown
---
title: "{Bug Title} — Debug Report"
type: debug
date: YYYY-MM-DD
severity: {critical|high|medium|low}
status: {root-caused|needs-investigation|unreproducible}
---

# {Bug Title} — Debug Report

## Summary
{One-line description of the bug}

## Expected Behavior
{What should happen}

## Actual Behavior
{What actually happens}

## Reproduction Steps
1. {Step 1}
2. {Step 2}
3. {Step 3}

## Environment
- {Relevant context: OS, version, config}

## Root Cause Analysis

### Failure Chain
1. {Entry point / trigger}
2. {Intermediate step}
3. {Failure point}

### Root Cause
{Detailed explanation of why the bug occurs}

### Evidence
- File: `{file}:{line}` — {what's wrong}
- File: `{file}:{line}` — {related code}

## Affected Files
- `{file}` — {role in the bug}
- `{file}` — {role in the bug}

## Suggested Fix
{High-level approach to fixing — NOT implementation}

### Fix Strategy
1. {Step 1}
2. {Step 2}

### Risk Assessment
- {Risk 1}: {mitigation}
- {Risk 2}: {mitigation}

## Verification Plan
How to verify the fix works:
1. {Test case 1}
2. {Test case 2}

## Related Issues
- {Link to related bugs, PRs, or discussions}

## Notes
{Any additional context, gotchas, or observations}
```

### Phase 5: Present & Handoff

Present summary to user:

> "Debug report written to `docs/debug/YYYY-MM-DD-<topic>-debug.md`"
> 
> **Root Cause:** {brief summary}
> **Suggested Fix:** {brief summary}

Then suggest:

**If root cause found:**
```
the fix step debug:YYYY-MM-DD-<topic>-debug
```

**If needs more investigation:**
> "Root cause unclear. Need to investigate {area} further."
```
the context-gathering step {area}
```

**If unreproducible:**
> "Cannot reproduce with current steps. Can you provide more details?"
- Wait for user input

---

## Differences from scan-issues

| Aspect | `the debug step` | `the issue scan` |
|--------|----------------|----------------------|
| Purpose | Investigate specific bug | Find potential issues |
| Input | Bug report / error message | Scope / category |
| Output | Debug report with root cause | Issue list with priorities |
| Depth | Deep single-issue analysis | Broad codebase scan |
| Handoff | `the fix step` | `a quick work pass` or `the brainstorm skill` |

---

## Notes

- Diagnosis only — fixes happen via `the fix step`
- Debug reports are reusable — `the fix step` can autocomplete them
- Subagent support enables parallel code path tracing
- Always document the failure chain — helps verify fixes
- If bug is complex, suggest `the consultant skill` for expert analysis
