---
name: chore-execute
description: "Execute a saved chore — run deploy, publish, push, or any repeatable task from docs/chore/."
---

# Executing Chores

Run saved chore definitions. Autocomplete available for chore file selection.

## Boundaries

**This skill MAY:** read chore file, run commands, ask user for confirmation, report results.
**This skill MAY NOT:** create new chores, edit code (unless chore requires it).

## Command Format

```
/unipi:chore-execute chore:<path>(optional) <string(greedy)>(optional)
```

- `chore:<path>` — chore file to execute (autocomplete available)
- `string(greedy)` — optional context or overrides (e.g., "skip tests", "dry run")
- If no chore provided → agent lists available chores and asks

## Input Path

```
.unipi/docs/chore/<chore-name>.md
```

---

## Process

### Phase 1: Load Chore

**If `chore:` arg provided:**
1. Read the chore file from `.unipi/docs/chore/`
2. Understand: steps, pre-conditions, failure handling

**If no chore provided:**
1. List available chore files in `.unipi/docs/chore/`
2. Present to user for selection (autocomplete-style)

```
Available chores:
┌─────────────────────────────┬─────────────────────────────────────┐
│ Chore                       │ Description                         │
├─────────────────────────────┼─────────────────────────────────────┤
│ push-github-main.md         │ Push current branch to GitHub main  │
│ publish-npm.md              │ Publish package to npm registry     │
│ deploy-staging.md           │ Deploy to staging environment       │
│ run-full-tests.md           │ Run complete test suite             │
└─────────────────────────────┴─────────────────────────────────────┘
```

**Exit:** Chore loaded. Steps understood.

### Phase 2: Pre-condition Check

Before executing, verify pre-conditions:

1. Read pre-conditions from chore file
2. For each pre-condition:
   - Run verification command if provided
   - Ask user to confirm if manual check
   - Report status

```
Pre-conditions:
✓ All changes committed — verified
✓ On correct branch — verified (main)
? Tests passing — should I run tests first?
```

**If pre-conditions fail:**
> "Pre-condition not met: {description}. Fix this before continuing?"
- If yes → help fix or wait for user
- If no → abort chore

**If `string(greedy)` contains overrides:**
- "skip tests" → skip test steps
- "dry run" → show commands without executing
- "force" → skip pre-condition checks (with warning)

**Exit:** Pre-conditions verified (or overridden).

### Phase 3: Execute Steps

For each step in the chore:

1. **Display step:**
   ```
   Step 2/5: Push to remote
   > git push origin main
   ```

2. **Confirm execution** (for destructive commands):
   > "Execute this step?"

3. **Run command:**
   ```bash
   {command}
   ```

4. **Check result:**
   - If success → proceed to next step
   - If failure → go to Phase 4 (Failure Handling)

5. **Report progress:**
   ```
   ✓ Step 1/5: Verify clean working tree
   ✓ Step 2/5: Push to remote
   ○ Step 3/5: Verify push (running...)
   ```

**Exit:** All steps completed.

### Phase 4: Failure Handling (if needed)

If a step fails:

1. **Report failure:**
   ```
   ✗ Step 2/5: Push to remote — FAILED
   Error: rejected (non-fast-forward)
   ```

2. **Check chore's failure handling section:**
   - Follow recovery steps
   - Run diagnostic commands
   - Ask user for decision

3. **Options:**
   - **Retry** — try the step again
   - **Skip** — skip this step (if non-critical)
   - **Abort** — stop chore execution
   - **Manual** — user handles this step

4. **If recovery succeeds:**
   > "Recovered from failure. Continuing..."
   → Resume execution

5. **If recovery fails:**
   > "Cannot recover. Chore aborted at step {N}."
   → Report what was completed and what remains

### Phase 5: Verify Completion

After all steps complete:

1. Run post-condition checks
2. Run verification commands from chore
3. Report success:

```
Chore Complete: {chore-name}

✓ Step 1: {name}
✓ Step 2: {name}
✓ Step 3: {name}
✓ Step 4: {name}
✓ Step 5: {name}

Post-conditions:
✓ {Post-condition 1} — verified
✓ {Post-condition 2} — verified
```

### Phase 6: Report

> "Chore `{chore-name}` completed successfully."

If there were issues:
> "Chore completed with notes: {notes}"

---

## Autocomplete Behavior

When user types `/unipi:chore-execute chore:`, autocomplete shows:

```
Available chores:
┌─────────────────────────────┬────────────┬─────────────────────────────────────┐
│ File                        │ Type       │ Description                         │
├─────────────────────────────┼────────────┼─────────────────────────────────────┤
│ push-github-main.md         │ git        │ Push current branch to GitHub main  │
│ publish-npm.md              │ publish    │ Publish package to npm registry     │
│ deploy-staging.md           │ deploy     │ Deploy to staging environment       │
└─────────────────────────────┴────────────┴─────────────────────────────────────┘
```

User selects one, or types path manually.

---

## Context Overrides

The `string(greedy)` parameter can override chore behavior:

| Override | Effect |
|----------|--------|
| `skip tests` | Skip test/verification steps |
| `dry run` | Show commands without executing |
| `force` | Skip pre-condition checks |
| `verbose` | Show detailed output |
| `step 3` | Start from step 3 |

Example:
```
/unipi:chore-execute chore:publish-npm skip tests
```

---

## Examples

### Execute Push to GitHub

```
/unipi:chore-execute chore:push-github-main
```

Output:
```
Loading chore: push-github-main
Description: Push current branch changes to GitHub main

Pre-conditions:
✓ All changes committed — verified (3 files committed)
✓ On correct branch — verified (main)

Executing steps:

Step 1/3: Verify clean working tree
> git status
✓ Working tree clean

Step 2/3: Push to remote
> git push origin main
✓ Pushed to origin/main

Step 3/3: Verify push
> git log --oneline -1
✓ Remote matches local

Post-conditions:
✓ Remote main is up to date

Chore push-github-main completed successfully.
```

### Execute Publish to NPM (with override)

```
/unipi:chore-execute chore:publish-npm dry run
```

Output:
```
Loading chore: publish-npm
Description: Publish package to npm registry
Mode: DRY RUN (commands shown but not executed)

Steps that would run:
1. npm whoami
2. npm test
3. npm run build
4. npm publish
5. npm view @pi-unipi/workflow version

Dry run complete. No commands executed.
```

---

## Error Recovery

When a step fails, the agent should:

1. **Diagnose** — understand why it failed
2. **Suggest** — propose recovery steps
3. **Execute** — try recovery if user approves
4. **Report** — explain what happened

Example:
```
Step 2/5: Push to remote
> git push origin main
✗ FAILED: rejected (non-fast-forward)

Diagnosis: Remote has commits not in local branch

Recovery options:
1. Pull and merge: git pull origin main
2. Force push: git push --force origin main (dangerous!)
3. Abort chore

Which option?
```

---

## Notes

- Chores are reusable — same chore can be run many times
- Autocomplete makes it easy to find the right chore
- Pre-condition checks prevent common failures
- Failure handling provides recovery paths
- Context overrides allow flexibility without editing chore files
- Chores stored in `.unipi/docs/chore/` for discoverability
