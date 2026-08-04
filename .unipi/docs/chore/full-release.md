---
name: full-release
type: chore
description: Full release pipeline — typecheck, lint, test, verify mounts, verify commands, update changelog, update docs, publish to npm, push to GitHub
created: 2026-04-28
last-run: 2026-08-04 (v2.2.0)
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
|-----------|-------------|----------|
| `packages/ask-user` | `@pi-unipi/ask-user` | 2.2.0 |
| `packages/autocomplete` | `@pi-unipi/command-enchantment` | 2.2.0 |
| `packages/btw` | `@pi-unipi/btw` | 2.2.0 |
| `packages/cocoindex` | `@pi-unipi/cocoindex` | 2.2.0 |
| `packages/compactor` | `@pi-unipi/compactor` | 2.2.0 |
| `packages/core` | `@pi-unipi/core` | 2.2.0 |
| `packages/footer` | `@pi-unipi/footer` | 2.2.0 |
| `packages/image` | `@pi-unipi/image` | 2.2.0 |
| `packages/info-screen` | `@pi-unipi/info-screen` | 2.2.0 |
| `packages/input-shortcuts` | `@pi-unipi/input-shortcuts` | 2.2.0 |
| `packages/kanboard` | `@pi-unipi/kanboard` | 2.2.0 |
| `packages/mcp` | `@pi-unipi/mcp` | 2.2.0 |
| `packages/memory` | `@pi-unipi/memory` | 2.2.0 |
| `packages/milestone` | `@pi-unipi/milestone` | 2.2.0 |
| `packages/notify` | `@pi-unipi/notify` | 2.2.0 |
| `packages/ralph` | `@pi-unipi/ralph` | 2.2.0 |
| `packages/subagents` | `@pi-unipi/subagents` | 2.2.0 |
| `packages/updater` | `@pi-unipi/updater` | 2.2.0 |
| `packages/utility` | `@pi-unipi/utility` | 2.2.0 |
| `packages/web-api` | `@pi-unipi/web-api` | 2.2.0 |
| `packages/workflow` | `@pi-unipi/workflow` | 2.2.0 |
| `packages/unipi` | `@pi-unipi/unipi` (root) | 2.2.0 |

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

Verify all paths listed in root `package.json` `pi.extensions` and `pi.skills` resolve after `npm install`:

```bash
node - <<'JS'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
let missing = false;
for (const key of ['extensions', 'skills']) {
  for (const item of pkg.pi[key]) {
    if (!fs.existsSync(item)) {
      console.log(`MISSING: ${item} (referenced in pi.${key})`);
      missing = true;
    } else {
      console.log(`OK: ${item}`);
    }
  }
}
process.exit(missing ? 1 : 0);
JS
```

Expected: All mounted extension/skill paths resolve. No MISSING entries. This path-based check correctly handles packages whose npm name differs from the workspace directory (for example `@pi-unipi/command-enchantment` lives in `packages/autocomplete`).

### Step 6: Verify Mounts — @packages/info-screen/

Check that info-screen's dependencies and references are consistent:

```bash
# Verify info-screen's dependencies exist in the monorepo
node - <<'JS'
const fs = require('fs');
const deps = Object.keys(JSON.parse(fs.readFileSync('packages/info-screen/package.json', 'utf8')).dependencies ?? {})
  .filter((dep) => dep.startsWith('@pi-unipi/'));
let missing = false;
for (const dep of deps) {
  const pkg = dep.replace('@pi-unipi/', '');
  const path = `packages/${pkg}`;
  if (!fs.existsSync(path)) {
    console.log(`MISSING: ${path} (dependency of info-screen)`);
    missing = true;
  } else {
    console.log(`OK: ${path}`);
  }
}
process.exit(missing ? 1 : 0);
JS
```

Expected: All info-screen dependencies resolve within the monorepo.

### Step 7: Verify Command Registry

Run the canonical autocomplete command-registry audit. This verifies that every package command registered with `pi.registerCommand()`:

- uses the full `unipi:` prefix (no bare `/foo` or `/foo:bar` package commands)
- exists in `packages/autocomplete/src/constants.ts` `COMMAND_REGISTRY`
- has a matching `COMMAND_DESCRIPTIONS` entry
- uses a package key that has a `PACKAGE_LABELS` entry

```bash
npm --workspace packages/autocomplete test -- src/__tests__/command-registry.audit.test.ts
```

Expected: audit test passes. If it fails:
1. Add missing `registerCommand` calls to the package, or add missing command constants to `packages/core/constants.ts`.
2. Ensure command registration uses `unipi:` (prefer `UNIPI_PREFIX` + `*_COMMANDS` constants).
3. Update all five autocomplete structures as needed: `PACKAGE_ORDER`, `PACKAGE_COLORS`, `COMMAND_REGISTRY`, `COMMAND_DESCRIPTIONS`, `PACKAGE_LABELS`.
4. Re-run the audit test before continuing.

Notes:
- Workflow dynamically registers `WORKFLOW_COMMANDS` via `fullCommand`; the audit understands this pattern.
- `/unipi:ralph` is a command with subcommands; do not require each `RALPH_COMMANDS` constant to be a separate registered slash command unless the package actually registers it.
- BTW commands must stay under `/unipi:btw*` and remain in the autocomplete registry.

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

### Step 8b: Bundle unipi Extension (Optional)

Regenerate the single-file bundle so npm consumers (especially on slow filesystems) get fast startup:

```bash
npx esbuild packages/unipi/index.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node24 \
  --external:better-sqlite3 \
  --external:@lancedb/* \
  --outfile=packages/unipi/bundled.js
```

Expected: `packages/unipi/bundled.js` regenerated (~1.1MB).
If esbuild not installed: `npm install -D esbuild`.

**Note:** This step is optional for local development on ext4 — `index.ts` loads in ~3s
directly. It matters for npm users who may be on slower filesystems (WSL2 /mnt, Docker mounts, NFS).

### Step 9: Update CHANGELOG.md

Update the root `CHANGELOG.md` to move `[Unreleased]` items into a new versioned section:

```bash
# Check what's in Unreleased
grep -A 50 '## \[Unreleased\]' CHANGELOG.md | head -60
# Get git log since last release
git log --oneline <last-release-commit>..HEAD
```

1. Create a new `## [X.Y.Z] — YYYY-MM-DD` section below `[Unreleased]`
2. Move all items from `[Unreleased]` into the new section
3. Add any additional changes discovered from `git log` since last release
4. If any public commands, tools, APIs, config keys, or package behavior were removed or made incompatible, add a `### Breaking Changes` section that starts each item with `BREAKING:` and gives the migration path
5. Keep `[Unreleased]` empty (with just the heading) for future work
6. Ensure format follows [Keep a Changelog](https://keepachangelog.com/)

**Changelog Tone — Slightly Technical:**
- **README** (non-technical): Tell user what command changed, what agent tool added, what behaviour modified. Focus on features, changes, and fixes from user perspective.
- **CHANGELOG** (slightly technical): Can mention function names, file names, technical details. Use fix/feature/change scope.

Example format:
```markdown
### Fixed
- `updater`: replaced `data.toLowerCase()` with `matchesKey()` in `readme-overlay.ts` to fix arrow key sequences
- `footer`: added 1-second refresh timer to `FooterGroup` so time segment updates
- `input-shortcuts`: refactored `ChordOverlay` to use deferred action pattern to unblock editor API

### Added
- `@pi-unipi/input-shortcuts` package — keyboard shortcuts with chord overlay, undo/redo, clipboard
- `/unipi:stash-settings` command — configure keyboard shortcuts and input behavior

### Changed
- Updater TUI overlays use `truncateToWidth()` and `visibleWidth()` from `@mariozechner/pi-tui` instead of custom implementations
```

Expected: CHANGELOG.md has populated version section and empty `[Unreleased]`.

### Step 10: Bump Versions

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

### Step 11: Update Documentation

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

### Step 12: Commit Documentation & Version Bumps

```bash
git add -A
git commit -m "chore: bump versions and update docs for release"
```

Expected: Commit succeeds.

### Step 13: Publish All Packages to npm

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

### Step 14: Verify Alias Performance

Confirm the `unipi` alias (which loads from ext4 source) starts fast after the release:

```bash
time bash -ic 'unipi -p ""'
```

Expected: ~4-6s (includes bash startup). If >10s, the alias may be loading from a stale path or /mnt/d.

### Step 15: Verify npm Publications

```bash
node - <<'JS' | while read -r name version; do
const fs = require('fs');
for (const dir of fs.readdirSync('packages')) {
  const pkgPath = `packages/${dir}/package.json`;
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  console.log(`${pkg.name} ${pkg.version}`);
}
JS
  echo "Checking $name@$version..."
  npm view "$name" version 2>/dev/null || echo "NOT FOUND: $name"
done
```

Expected: All packages show their new versions on npm.

### Step 16: Push to GitHub

```bash
git push origin main
```

If the branch is behind:
```bash
git pull --rebase origin main
git push origin main
```

Expected: Push succeeds, remote is up to date.

### Step 17: Create Git Tag (Optional)

```bash
VERSION=$(node -p "require('./package.json').version")
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
4. Continue from Step 9

If **tests fail**:
1. Read test output to identify failures
2. Fix the failing tests or the code they test
3. Re-run tests
4. Continue from Step 10

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
- [ ] `packages/unipi/bundled.js` regenerated (if Step 8b ran)
- [ ] All packages published to npm with new versions
- [ ] `unipi` alias starts in <6s (`time bash -ic 'unipi -p ""'`)
- [ ] Changes pushed to GitHub
- [ ] Git tag created (optional)

## Notes

- **Dependency order matters** for npm publish — `core` should be published first since other packages depend on it
- **`packages/unipi`** is just an `index.ts` barrel — it doesn't have its own `package.json`, the root `package.json` IS `@pi-unipi/unipi`
- **`packages/autocomplete`** contains `@pi-unipi/command-enchantment` (directory name differs from package name)
- **Version strategy**: Bump patch by default. Use minor for new features. For breaking changes, choose the appropriate pre-1.0 compatibility bump and document `BREAKING:` migration notes in `CHANGELOG.md`.
- **Documentation tone**: Be proud of what Unipi does. It's not just another tool — it's a structured development system with memory, parallelism, and iterative loops
- **Command registry**: All commands use `unipi:` prefix via `UNIPI_PREFIX` from `@pi-unipi/core`. Constants are the source of truth — if a constant exists, a registration must exist
