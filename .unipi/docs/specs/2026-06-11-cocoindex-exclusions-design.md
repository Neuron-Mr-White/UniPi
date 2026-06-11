---
title: "CocoIndex: Comprehensive File Exclusion Support"
type: brainstorm
date: 2026-06-11
---

# CocoIndex: Comprehensive File Exclusion Support

## Problem Statement

The CocoIndex pipeline template (`packages/cocoindex/bridge.ts`) generates a
`main.py` with a hardcoded, JS/Node-centric exclusion list. Python projects end
up indexing `.venv/`, `.nox/`, `.tox/`, `*.egg-info/`, and thousands of
irrelevant third-party files. The exclusion logic is also static — it doesn't
respect `.gitignore`, `CACHEDIR.TAG`, or user-global excludes.

## Context

- Template: `packages/cocoindex/bridge.ts` → `generatePipelineTemplate()` (line 679)
- Template is only scaffolded once (existing `main.py` is never overwritten)
- The exclusion logic must therefore be **runtime** in the generated Python code
- CocoIndex's `PatternFilePathMatcher` handles glob patterns for the walker
- The walker can be pre-filtered (faster) or post-filtered (more flexible)

## Chosen Approach

Four-tier runtime exclusion system, all inline in the generated `main.py`:

1. **Expanded default exclusions** — add Python/Rust/Go/Java/OS patterns
2. **CACHEDIR.TAG detection** — skip directories with valid cache tag at walk time
3. **Git-aware exclusion** — use `git check-ignore` CLI to respect all gitignore
   sources (`.gitignore`, `core.excludesFile`, `$GIT_DIR/info/exclude`, nested
   `.gitignore` files)
4. **User-global excludes** — read `~/.unipi/cocoindex/excludes` for per-user
   patterns

## Why This Approach

- **Runtime, not scaffold-time**: Since `main.py` is only generated once, all
  exclusion logic must live in the template's Python code, evaluated at index time
- **`git check-ignore` over manual parsing**: Git has complex precedence rules
  for ignore files. Using the CLI gives us correct behavior for free — respects
  `core.excludesFile` from `~/.gitconfig`, nested `.gitignore`, negation patterns,
  `$GIT_DIR/info/exclude`, etc.
- **Layered approach**: Each tier independently adds value. Even if git isn't
  available, Tiers 1+2+4 still work.
- **Inline over separate module**: Keeps scaffolding simple (one file), avoids
  import path issues

## Design

### Architecture

The generated `main.py` will have these additions:

```
┌─────────────────────────────────────────────┐
│ Tier 1: Expanded excluded_patterns list     │  (PatternFilePathMatcher)
├─────────────────────────────────────────────┤
│ Tier 2: is_cache_dir() check                │  (CACHEDIR.TAG signature)
├─────────────────────────────────────────────┤
│ Tier 3: is_git_ignored() check              │  (subprocess: git check-ignore)
├─────────────────────────────────────────────┤
│ Tier 4: load_user_excludes()                │  (~/.unipi/cocoindex/excludes)
│         → merged into excluded_patterns     │
└─────────────────────────────────────────────┘
```

### Tier 1: Expanded Excluded Patterns

Add to the static `excluded_patterns` list:

```python
# Python
"**/.venv/**", "**/venv/**", "**/.nox/**", "**/.tox/**",
"**/*.egg-info/**", "**/.mypy_cache/**",
"**/.pytest_cache/**", "**/.ruff_cache/**",
"**/.pytype/**", "**/.pyre/**",

# Rust
"**/target/**",

# Go
"**/vendor/**",

# Java/Kotlin
"**/.gradle/**", "**/out/**",

# General / OS
"**/.DS_Store", "**/Thumbs.db",
"**/.env", "**/.env.local",
```

### Tier 2: CACHEDIR.TAG Detection

```python
import os, subprocess

CACHEDIR_SIGNATURE = b"Signature: 8a477f597d28d172789f06886806bc55"

def is_cache_dir(path: str) -> bool:
    """Check if directory has a valid CACHEDIR.TAG."""
    tag = os.path.join(path, "CACHEDIR.TAG")
    try:
        with open(tag, "rb") as f:
            return f.read(43) == CACHEDIR_SIGNATURE
    except (OSError, IOError):
        return False
```

Applied as a pre-filter: before walking into a directory, check for the tag.
Since `PatternFilePathMatcher` doesn't support directory-level callbacks, we'll
implement this as a **post-filter** on each file — checking if any ancestor
directory has a `CACHEDIR.TAG`. To avoid repeated filesystem hits, we cache
results.

```python
_cachedir_cache: dict[str, bool] = {}

def has_cache_ancestor(file_path: str, root: str) -> bool:
    """Check if any ancestor dir (between root and file) is a cache dir."""
    parts = pathlib.Path(file_path).relative_to(root).parents
    for parent in parts:
        dir_path = str(pathlib.Path(root) / parent)
        if dir_path not in _cachedir_cache:
            _cachedir_cache[dir_path] = is_cache_dir(dir_path)
        if _cachedir_cache[dir_path]:
            return True
    return False
```

### Tier 3: Git-Aware Exclusion

Use `git check-ignore` in batch mode for efficiency:

```python
def get_git_ignored_files(file_paths: list[str], cwd: str) -> set[str]:
    """Ask git which files are ignored. Returns set of ignored paths."""
    if not file_paths:
        return set()
    try:
        result = subprocess.run(
            ["git", "check-ignore", "--stdin", "-z"],
            input="\0".join(file_paths),
            capture_output=True,
            text=True,
            cwd=cwd,
            timeout=30,
        )
        if result.returncode == 128:
            # Not a git repo
            return set()
        # Output is NUL-separated list of ignored paths
        return set(p for p in result.stdout.split("\0") if p)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return set()
```

This is called in batches during the walk phase. Files reported as ignored are
skipped before chunking.

### Tier 4: User-Global Excludes

```python
def load_user_excludes() -> list[str]:
    """Load patterns from ~/.unipi/cocoindex/excludes (one per line)."""
    excludes_file = pathlib.Path.home() / ".unipi" / "cocoindex" / "excludes"
    if not excludes_file.exists():
        return []
    patterns = []
    for line in excludes_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(line)
    return patterns
```

These patterns are merged into `excluded_patterns` at runtime, before the
walker is constructed.

### Integration in the Walk Phase

The generated template's `app_main()` becomes:

```python
async def app_main() -> None:
    project_root = pathlib.Path(PROJECT_ROOT)

    # Tier 4: merge user excludes into pattern list
    user_excludes = load_user_excludes()
    all_excluded = DEFAULT_EXCLUDED_PATTERNS + user_excludes

    # Walker with Tier 1 + 4 patterns
    walker = localfs.walk_dir(
        project_root,
        recursive=True,
        path_matcher=PatternFilePathMatcher(
            included_patterns=[...],
            excluded_patterns=all_excluded,
        ),
    )

    # Collect file paths for Tier 3 batch check
    files_to_process = []
    async for file in walker:
        rel = file.file_path.path.as_posix()
        # Tier 2: CACHEDIR.TAG check
        if has_cache_ancestor(str(project_root / rel), str(project_root)):
            continue
        files_to_process.append((file, rel))

    # Tier 3: git check-ignore (batch)
    all_paths = [rel for _, rel in files_to_process]
    git_ignored = get_git_ignored_files(all_paths, str(project_root))

    # Process non-ignored files
    for file, rel in files_to_process:
        if rel in git_ignored:
            continue
        await coco.mount(
            coco.component_subpath("process", rel),
            process_file,
            file,
            table,
        )
```

### Error Handling

- **No git installed**: `FileNotFoundError` caught → skip Tier 3, continue
- **Not a git repo**: `returncode == 128` → skip Tier 3, continue
- **No `~/.unipi/cocoindex/excludes`**: returns empty list → no effect
- **Invalid CACHEDIR.TAG**: partial read → returns False → directory walked

### Testing Approach

1. Manual test: create project with `.venv/` containing `CACHEDIR.TAG`,
   run indexing, verify no venv files indexed
2. Test with `.gitignore` containing custom patterns
3. Test without git (ensure graceful degradation)
4. Test with `~/.unipi/cocoindex/excludes` file

## Implementation Checklist

- [x] Tier 1: Expand default excluded_patterns in template
- [x] Tier 2: Add CACHEDIR.TAG detection (is_cache_dir + ancestor check)
- [x] Tier 3: Add git check-ignore batch integration
- [x] Tier 4: Add user-global excludes file loading
- [x] Restructure app_main() to integrate all tiers
- [x] Ensure backward compatibility (existing scaffolded main.py unaffected)

## Open Questions

- **Batch size for git check-ignore**: Very large repos may have 100k+ files.
  Should we batch in chunks of 1000? → Yes, added chunking.
- **Caching git results across runs**: CocoIndex handles incremental updates
  itself; we just need to filter per run. No cross-run cache needed.

## Out of Scope

- Modifying already-scaffolded `main.py` files (users can re-scaffold manually)
- Adding a CocoIndex plugin/middleware API
- UI for managing excludes (users edit the file directly)
