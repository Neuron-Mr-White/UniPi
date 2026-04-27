---
name: chore-create
description: "Create reusable chore — save repeatable tasks like deploy, publish, push to docs/chore/."
---

# Creating Chores

Create reusable chore definitions for repeatable tasks. Save to `.unipi/docs/chore/` for future execution.

## Boundaries

**This skill MAY:** read codebase, ask questions, write chore to `.unipi/docs/chore/`.
**This skill MAY NOT:** edit code, execute the chore, run tests, deploy.

**This is definition only — not execution.**

## Command Format

```
/unipi:chore-create <string(greedy)>
```

- `string(greedy)` — description of the chore to create (e.g., "push to github main", "publish npm package")
- Write-only sandbox (`.unipi/docs/chore/`)

## Output Path

```
.unipi/docs/chore/<chore-name>.md
```

---

## Process

### Phase 1: Understand the Chore

1. Read the chore description
2. Ask clarifying questions (one at a time):
   - "What are the exact steps for this chore?"
   - "Any pre-conditions before running?"
   - "What should happen if a step fails?"
   - "Is this interactive or fully automated?"

3. Determine chore type:
   - **Deploy** — push to production/staging
   - **Publish** — npm, pypi, docker registry
   - **Git** — push, merge, release
   - **Build** — compile, bundle, package
   - **Test** — run specific test suites
   - **Maintenance** — cleanup, backup, sync
   - **Custom** — any repeatable task

**Exit:** Chore understood, steps clear.

### Phase 2: Design Chore Structure

Plan the chore:

1. **Name** — kebab-case, descriptive (e.g., `push-github-main`, `publish-npm`)
2. **Steps** — ordered list of commands/actions
3. **Pre-conditions** — what must be true before running
4. **Post-conditions** — what should be true after success
5. **Failure handling** — what to do if steps fail
6. **Interactive points** — where user input may be needed

**Exit:** Structure designed.

### Phase 3: Write Chore File

Create `.unipi/docs/chore/<chore-name>.md`:

```markdown
---
name: {chore-name}
type: chore
description: {One-line description}
created: YYYY-MM-DD
---

# {Chore Name}

{Description of what this chore does and when to use it}

## Pre-conditions

Before running this chore, ensure:
- [ ] {Pre-condition 1}
- [ ] {Pre-condition 2}

## Steps

### Step 1: {Step Name}
{What to do}

```bash
{command}
```

Expected: {what should happen}

### Step 2: {Step Name}
{What to do}

```bash
{command}
```

Expected: {what should happen}

### Step N: Verify
{How to verify success}

```bash
{verification command}
```

Expected: {success indicator}

## Failure Handling

If any step fails:
1. {What to check}
2. {How to recover}
3. {When to abort}

## Post-conditions

After successful completion:
- [ ] {Post-condition 1}
- [ ] {Post-condition 2}

## Notes
{Any additional context, gotchas, or tips}
```

### Phase 4: Self-Review

Before presenting:
1. Are all steps clear and executable?
2. Are commands correct and tested?
3. Is failure handling comprehensive?
4. Would someone else be able to run this?

### Phase 5: Present & Handoff

Present to user:

> "Chore created at `.unipi/docs/chore/<chore-name>.md`"
>
> **Steps:** {count} steps
> **Type:** {deploy/publish/git/etc.}

Then suggest:

```
/unipi:chore-execute chore:<chore-name>
```

Or if more chores needed:
> "Need to create more chores?"

---

## Chore Naming Convention

Use kebab-case with action-verb prefix:

| Pattern | Example |
|---------|---------|
| `push-{target}` | `push-github-main`, `push-github-develop` |
| `publish-{registry}` | `publish-npm`, `publish-docker` |
| `deploy-{env}` | `deploy-staging`, `deploy-production` |
| `run-{suite}` | `run-unit-tests`, `run-e2e-tests` |
| `sync-{service}` | `sync-translations`, `sync-config` |
| `backup-{target}` | `backup-database`, `backup-files` |
| `release-{type}` | `release-patch`, `release-minor` |

---

## Examples

### Push to GitHub Main

```
/unipi:chore-create push current branch to github main
```

Creates `.unipi/docs/chore/push-github-main.md`:
```markdown
---
name: push-github-main
type: chore
description: Push current branch changes to GitHub main
created: 2026-04-28
---

# Push to GitHub Main

Push committed changes from current branch to GitHub main branch.

## Pre-conditions
- [ ] All changes committed
- [ ] On correct branch
- [ ] Tests passing

## Steps

### Step 1: Verify clean working tree
```bash
git status
```
Expected: "nothing to commit, working tree clean"

### Step 2: Push to remote
```bash
git push origin main
```
Expected: Success with no errors

### Step 3: Verify push
```bash
git log --oneline -1
```
Expected: Latest commit matches remote

## Failure Handling
If push rejected:
1. Pull latest: `git pull origin main`
2. Resolve conflicts if any
3. Retry push

## Post-conditions
- [ ] Remote main is up to date
```

### Publish to NPM

```
/unipi:chore-create publish package to npm registry
```

Creates `.unipi/docs/chore/publish-npm.md`:
```markdown
---
name: publish-npm
type: chore
description: Publish package to npm registry
created: 2026-04-28
---

# Publish to NPM

Publish the current package version to npm registry.

## Pre-conditions
- [ ] Logged in to npm (`npm whoami`)
- [ ] Version bumped in package.json
- [ ] All changes committed
- [ ] Tests passing

## Steps

### Step 1: Verify npm login
```bash
npm whoami
```
Expected: Your npm username

### Step 2: Run tests
```bash
npm test
```
Expected: All tests passing

### Step 3: Build package
```bash
npm run build
```
Expected: Build succeeds

### Step 4: Publish
```bash
npm publish
```
Expected: Package published successfully

### Step 5: Verify publication
```bash
npm view {package-name} version
```
Expected: Matches package.json version

## Failure Handling
If publish fails:
1. Check npm login: `npm whoami`
2. Check version: must be higher than current
3. Check package name conflicts

## Post-conditions
- [ ] Package available on npm
- [ ] Version matches package.json
```

---

## Notes

- Chores are reusable — create once, execute many times
- Keep steps clear and executable by anyone
- Include verification steps for confidence
- Document failure scenarios for resilience
- Chores are stored in `.unipi/docs/chore/` for discoverability
