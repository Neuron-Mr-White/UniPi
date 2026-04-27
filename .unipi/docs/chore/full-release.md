---
name: full-release
type: chore
description: Full release pipeline — typecheck, lint, test, verify mounts, verify commands, update docs, publish to npm, push to GitHub
created: 2026-04-28
---

# Full Release Pipeline

End-to-end release for the Unipi monorepo. Validates all packages, verifies command registry, updates documentation, publishes to npm, and pushes to GitHub.

**Use when:** You're ready to cut a release with all packages updated.

## Pre-conditions

Before running this chore, ensure:
- [ ] All code changes are committed
- [ ] You are on the `main` branch (or the target release branch)
- [ ] You are logged in to npm (`npm whoami` returns your username)
- [ ] You have push access to the GitHub remote
- [ ] Working tree is clean (`git status`)

## Package Inventory

| Directory | npm Package | Version |
|-----------|-------------|---------|
| `packages/ask-user` | `@pi-unipi/ask-user` | 0.1.2 |
| `packages/autocomplete` | `@pi-unipi/command-enchantment` | 0.1.0 |
| `packages/btw` | `@pi-unipi/btw` | 0.1.1 |
| `packages/compactor` | `@pi-unipi/compactor` | 0.1.0 |
| `packages/core` | `@pi-unipi/core` | 0.1.7 |
| `packages/info-screen` | `@pi-unipi/info-screen` | 0.1.13 |
| `packages/mcp` | `@pi-unipi/mcp` | 0.1.6 |
| `packages/memory` | `@pi-unipi/memory` | 0.1.5 |
| `packages/notify` | `@pi-unipi/notify` | 0.1.0 |
| `packages/ralph` | `@pi-unipi/ralph` | 0.1.2 |
| `packages/subagents` | `@pi-unipi/subagents` | 0.1.12 |
| `packages/utility` | `@pi-unipi/utility` | 0.2.0 |
| `packages/web-api` | `@pi-unipi/web-api` | 0.1.7 |
| `packages/workflow` | `@pi-unipi/workflow` | 0.1.8 |
| `packages/unipi` | `@pi-unipi/unipi` (root) | 0.1.8 |

---

## Steps

### Step 1: Verify Clean Working Tree

```bash
git status
```

Expected: `nothing to commit, working tree clean`

If dirty: commit or stash changes before proceeding.

### Step 2: Install Dependencies

```bash
npm install
```

Expected: All workspace dependencies resolve, no errors.

### Step 3: Typecheck All Packages

```bash
npx tsc --noEmit --skipLibCheck
```

Expected: No type errors. If errors found, fix them before continuing.

### Step 4: Lint All Packages

Check if ESLint or similar is configured:

```bash
cat package.json | grep -E "lint|eslint"
```

If lint script exists:
```bash
npm run lint --workspaces
```

If no lint script, skip — typecheck is the primary quality gate.

Expected: No lint errors (or lint not configured).

### Step 5: Verify Mounts — @packages/unipi/

Verify all packages listed in root `package.json` `pi.extensions` and `pi.skills` actually exist:

```bash
# Check all extension paths resolve
for ext in $(cat package.json | jq -r '.pi.extensions[]' | sed 's|node_modules/@pi-unipi/||'); do
  pkg=$(echo "$ext" | cut -d'/' -f1)
  if [ ! -d "packages/$pkg" ]; then
    echo "MISSING: packages/$pkg (referenced in pi.extensions)"
  else
    echo "OK: packages/$pkg"
  fi
done

# Check all skill paths resolve
for skill in $(cat package.json | jq -r '.pi.skills[]' | sed 's|node_modules/@pi-unipi/||'); do
  pkg=$(echo "$skill" | cut -d'/' -f1)
  if [ ! -d "packages/$pkg" ]; then
    echo "MISSING: packages/$pkg (referenced in pi.skills)"
  else
    echo "OK: packages/$pkg"
  fi
done
```

Expected: All packages resolve. No MISSING entries.

### Step 6: Verify Mounts — @packages/info-screen/

Check that info-screen's dependencies and references are consistent:

```bash
# Verify info-screen's dependencies exist in the monorepo
for dep in $(cat packages/info-screen/package.json | jq -r '.dependencies // {} | keys[]' | grep '@pi-unipi'); do
  pkg=$(echo "$dep" | sed 's/@pi-unipi\///')
  if [ ! -d "packages/$pkg" ]; then
    echo "MISSING: packages/$pkg (dependency of info-screen)"
  else
    echo "OK: packages/$pkg"
  fi
done
```

Expected: All info-screen dependencies resolve within the monorepo.

### Step 7: Verify Command Registry

Ensure every command constant in `@pi-unipi/core/constants.ts` is actually registered by its owning package, and that no orphan commands exist.

**Workflow commands** (20 commands, registered in `packages/workflow/commands.ts`):
```bash
# Extract expected commands from constants
grep -oP 'WORKFLOW_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_workflow.txt

# Extract actually registered commands
grep -oP 'WORKFLOW_COMMANDS\.\K[A_]+' packages/workflow/commands.ts | sort -u > /tmp/registered_workflow.txt

diff /tmp/expected_workflow.txt /tmp/registered_workflow.txt
```
Expected: No differences. All 20 workflow commands registered: `brainstorm`, `plan`, `work`, `review-work`, `consolidate`, `worktree-create`, `worktree-list`, `worktree-merge`, `consultant`, `quick-work`, `gather-context`, `document`, `scan-issues`, `auto`, `debug`, `fix`, `quick-fix`, `research`, `chore-create`, `chore-execute`.

**Ralph commands** (registered in `packages/ralph/index.ts`):
```bash
grep -oP 'RALPH_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_ralph.txt
grep 'registerCommand.*ralph' packages/ralph/index.ts | grep -oP 'unipi:\K[a-z-]+' | sort > /tmp/registered_ralph.txt
diff /tmp/expected_ralph.txt /tmp/registered_ralph.txt
```
Expected: No differences. Ralph commands: `ralph-start`, `ralph-stop`, `ralph-resume`, `ralph-status`, `ralph-cancel`, `ralph-archive`, `ralph-clean`, `ralph-list`, `ralph-nuke`.

**Utility commands** (registered in `packages/utility/src/commands.ts`):
```bash
grep -oP 'UTILITY_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_utility.txt
grep -oP 'UTILITY_COMMANDS\.\K[A_]+' packages/utility/src/commands.ts | sort -u > /tmp/registered_utility.txt
diff /tmp/expected_utility.txt /tmp/registered_utility.txt
```
Expected: No differences. Utility commands: `continue`, `reload`, `status`, `cleanup`, `env`, `doctor`.

**MCP commands** (registered in `packages/mcp/src/index.ts`):
```bash
grep -oP 'MCP_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_mcp.txt
grep -oP 'MCP_COMMANDS\.\K[A_]+' packages/mcp/src/index.ts | sort -u > /tmp/registered_mcp.txt
diff /tmp/expected_mcp.txt /tmp/registered_mcp.txt
```
Expected: No differences. MCP commands: `mcp-add`, `mcp-settings`, `mcp-sync`, `mcp-status`, `mcp-reload`.

**Compactor commands** (registered in `packages/compactor/src/commands/index.ts`):
```bash
grep -oP 'COMPACTOR_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_compactor.txt
grep 'registerCommand' packages/compactor/src/commands/index.ts | grep -oP 'registerCommand\("\K[^"]+' | sort > /tmp/registered_compactor.txt
diff /tmp/expected_compactor.txt /tmp/registered_compactor.txt
```
Expected: No differences. Compactor commands: `compact`, `compact-recall`, `compact-stats`, `compact-doctor`, `compact-settings`, `compact-preset`, `compact-index`, `compact-search`, `compact-purge`.

**Notify commands** (registered in `packages/notify/index.ts`):
```bash
grep -oP 'NOTIFY_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_notify.txt
grep 'registerCommand' packages/notify/index.ts | grep -oP 'unipi:\K[a-z-]+' | sort > /tmp/registered_notify.txt
diff /tmp/expected_notify.txt /tmp/registered_notify.txt
```
Expected: No differences. Notify commands: `notify-settings`, `notify-set-gotify`, `notify-set-tg`, `notify-test`.

**Web-api commands** (registered in `packages/web-api/src/commands.ts`):
```bash
grep -oP 'WEB_COMMANDS\.\K[A_]+' packages/core/constants.ts | sort > /tmp/expected_web.txt
grep -oP 'WEB_COMMANDS\.\K[A_]+' packages/web-api/src/commands.ts | sort -u > /tmp/registered_web.txt
diff /tmp/expected_web.txt /tmp/registered_web.txt
```
Expected: No differences.

**Info-screen commands** (registered in `packages/info-screen/index.ts`):
```bash
grep 'registerCommand' packages/info-screen/index.ts
```
Expected: `unipi:info` and `unipi:info-settings` registered.

**Reverse check — no orphan registrations** (commands registered but missing from constants):
```bash
grep -rhoP 'registerCommand\("unipi:\K[a-z-]+' packages/ | sort -u > /tmp/all_registered.txt
cat /tmp/expected_*.txt | sed 's/_/-/g' | tr '[:upper:]' '[:lower:]' | sort -u > /tmp/all_expected.txt
diff /tmp/all_registered.txt /tmp/all_expected.txt
```
Expected: Every registered command has a matching constant. No orphan commands.

If any diff shows differences:
1. Add missing `registerCommand` calls to the package
2. Or add missing constants to `core/constants.ts`
3. Ensure the command prefix is `unipi:` (using `UNIPI_PREFIX`)

### Step 8: Run Tests for Each Package

Run tests across all workspaces:

```bash
npm test --workspaces --if-present 2>&1
```

If some packages don't have tests, run individually for those that do:

```bash
for pkg in packages/*/; do
  name=$(basename "$pkg")
  if [ -f "$pkg/package.json" ] && grep -q '"test"' "$pkg/package.json"; then
    echo "--- Testing @pi-unipi/$name ---"
    (cd "$pkg" && npm test) || echo "FAILED: @pi-unipi/$name"
  else
    echo "--- Skipping @pi-unipi/$name (no test script) ---"
  fi
done
```

Expected: All tests pass. If any fail, fix before continuing.

### Step 9: Bump Versions

For each package that has changes, bump the patch version:

```bash
for pkg in packages/*/; do
  if [ -f "$pkg/package.json" ]; then
    (cd "$pkg" && npm version patch --no-git-tag-version) 2>/dev/null
  fi
done

# Bump root
npm version patch --no-git-tag-version
```

Expected: All package.json versions incremented.

**Note:** If you want minor or major bumps, adjust accordingly. Review `git log` since last release to decide.

### Step 10: Update Documentation

Update each package's README and the root README:

**For each package:**
1. Read current `packages/<name>/README.md`
2. Verify all listed commands/features actually exist in code
3. Update stale descriptions, commands, or examples
4. Make wording compelling — highlight what makes Unipi different

**For root README:**
1. Verify package table is complete and accurate
2. Verify all commands listed actually exist
3. Update version numbers if shown
4. Polish the writing — make it engaging, not robotic
5. Highlight differentiators: structured workflows, persistent memory, parallel agents, ralph loops

```bash
# Check which packages have READMEs
for pkg in packages/*/; do
  if [ -f "$pkg/README.md" ]; then
    echo "Has README: $(basename $pkg)"
  else
    echo "Missing README: $(basename $pkg)"
  fi
done
```

**Key differentiators to emphasize:**
- 20 structured workflow commands (brainstorm → plan → work → review → merge)
- Persistent cross-session memory with vector search
- Parallel sub-agent execution with file locking
- Ralph: long-running iterative development loops
- Compactor: session compaction and context management
- Info-screen dashboard overlay
- MCP integration for external tool servers
- All-in-one install: `pi install npm:@pi-unipi/unipi`

### Step 11: Commit Documentation & Version Bumps

```bash
git add -A
git commit -m "chore: bump versions and update docs for release"
```

Expected: Commit succeeds.

### Step 12: Publish All Packages to npm

Publish each package (dependencies must be published first):

```bash
# Publish in dependency order (core first, then others, unipi last)
npm publish --workspaces --access public
```

If selective publish needed:
```bash
# Publish core first
cd packages/core && npm publish --access public && cd ../..

# Publish remaining
for pkg in packages/*/; do
  name=$(basename "$pkg")
  if [ "$name" != "core" ] && [ "$name" != "unipi" ] && [ -f "$pkg/package.json" ]; then
    echo "--- Publishing @pi-unipi/$name ---"
    (cd "$pkg" && npm publish --access public) || echo "FAILED: @pi-unipi/$name"
  fi
done

# Publish root last
npm publish --access public
```

Expected: All packages published successfully.

### Step 13: Verify npm Publications

```bash
for pkg in packages/*/; do
  if [ -f "$pkg/package.json" ]; then
    name=$(cat "$pkg/package.json" | jq -r '.name')
    version=$(cat "$pkg/package.json" | jq -r '.version')
    echo "Checking $name@$version..."
    npm view "$name" version 2>/dev/null || echo "NOT FOUND: $name"
  fi
done
```

Expected: All packages show their new versions on npm.

### Step 14: Push to GitHub

```bash
git push origin main
```

If the branch is behind:
```bash
git pull --rebase origin main
git push origin main
```

Expected: Push succeeds, remote is up to date.

### Step 15: Create Git Tag (Optional)

```bash
VERSION=$(cat package.json | jq -r '.version')
git tag "v$VERSION"
git push origin "v$VERSION"
```

Expected: Tag created and pushed.

---

## Failure Handling

If **typecheck fails**:
1. Read the error messages carefully
2. Fix type errors in the relevant packages
3. Re-run typecheck
4. Continue from Step 4

If **command registry check fails**:
1. Identify which commands are missing or orphaned
2. Add missing `registerCommand` calls or constants
3. Re-run the verification
4. Continue from Step 8

If **tests fail**:
1. Read test output to identify failures
2. Fix the failing tests or the code they test
3. Re-run tests
4. Continue from Step 9

If **npm publish fails** for a package:
1. Check if logged in: `npm whoami`
2. Check if version already exists: `npm view <name> version`
3. If version conflict: bump version and retry
4. If auth error: `npm login` and retry

If **git push fails**:
1. Pull latest: `git pull --rebase origin main`
2. Resolve conflicts if any
3. Retry push

If **any step fails and cannot be resolved**:
1. Do NOT publish partially — revert version bumps if needed
2. Document the failure
3. Abort and investigate

## Post-conditions

After successful completion:
- [ ] All packages typecheck cleanly
- [ ] All tests pass
- [ ] All packages mounted correctly in root and info-screen
- [ ] All commands registered correctly in command registry
- [ ] Documentation is accurate and compelling
- [ ] All packages published to npm with new versions
- [ ] Changes pushed to GitHub
- [ ] Git tag created (optional)

## Notes

- **Dependency order matters** for npm publish — `core` should be published first since other packages depend on it
- **`packages/unipi`** is just an `index.ts` barrel — it doesn't have its own `package.json`, the root `package.json` IS `@pi-unipi/unipi`
- **`packages/autocomplete`** contains `@pi-unipi/command-enchantment` (directory name differs from package name)
- **Version strategy**: Bump patch by default. Use minor for new features, major for breaking changes
- **Documentation tone**: Be proud of what Unipi does. It's not just another tool — it's a structured development system with memory, parallelism, and iterative loops
- **Command registry**: All commands use `unipi:` prefix via `UNIPI_PREFIX` from `@pi-unipi/core`. Constants are the source of truth — if a constant exists, a registration must exist
