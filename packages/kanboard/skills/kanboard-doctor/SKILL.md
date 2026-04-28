---
name: kanboard-doctor
description: "Diagnose and fix kanboard parser issues — validates all workflow documents, reports errors, suggests fixes."
---

# Kanboard Doctor

Diagnose parser issues across all workflow documents. Non-destructive — only suggests fixes, asks user to confirm.

## Phase 1: Run All Parsers

Execute each parser against its document type directory:

1. Load the parser registry from `@pi-unipi/kanboard`
2. Run `registry.parseAll(".unipi/docs")` to parse all documents
3. Collect all `ParsedDoc` results including their `warnings` arrays

## Phase 2: Collect Errors

Group warnings and errors by file with line numbers:

1. For each `ParsedDoc` with `warnings.length > 0`:
   - Group by `filePath`
   - Include line numbers where available
   - Categorize: malformed checkboxes, empty fields, parse failures
2. Also flag documents that returned 0 items (may indicate parsing failure)

## Phase 3: Present Report

Show a structured error report:

```
📋 Kanboard Doctor Report

Files scanned: N
Files with issues: M

📄 .unipi/docs/specs/example.md
  ⚠ Line 15: Empty checkbox text
  ⚠ Line 23: Malformed checkbox (missing bracket)

📄 .unipi/docs/plans/old-plan.md
  ⚠ Line 5: Empty task name after status
```

## Phase 4: Fix One by One

For each issue, suggest a fix and ask user to confirm:

1. Show the problematic line with context
2. Suggest the corrected version
3. Ask: "Apply this fix? (y/n)"
4. If yes, apply the fix using the edit tool
5. Move to next issue

**Non-destructive rules:**
- Never modify without asking
- Show before/after for each change
- Allow skipping individual fixes
- Allow "fix all" for simple patterns (e.g., trailing whitespace)

## Phase 5: Re-validate

After each fix, re-run the parser on the modified file:

1. Parse the file again
2. Verify the specific error is resolved
3. Check that no new errors were introduced
4. Report: "✓ Fixed" or "✗ Still has issues"

After all fixes, run full `registry.parseAll()` to confirm clean state.
