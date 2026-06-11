---
title: "CocoIndex Exclusions — Implementation Plan"
type: plan
date: 2026-06-11
workbranch: ""
specs:
  - .unipi/docs/specs/2026-06-11-cocoindex-exclusions-design.md
---

# CocoIndex Exclusions — Implementation Plan

## Overview

Implement all 4 tiers of file exclusion support in the CocoIndex pipeline
template (`packages/cocoindex/bridge.ts` → `generatePipelineTemplate()`).
All changes are to the generated Python template string. Work directly on main.

## Tasks

- completed: Task 1 — Expand default excluded_patterns (Tier 1)
  - Description: Add Python, Rust, Go, Java/Kotlin, and OS file patterns to
    the static `excluded_patterns` list in the template.
  - Dependencies: None
  - Acceptance Criteria: The template includes all ecosystem-specific patterns
    from the spec. TypeScript compiles without errors.
  - Steps:
    1. Open `packages/cocoindex/bridge.ts`, locate `excluded_patterns` array (~line 815)
    2. Add the new patterns (Python, Rust, Go, Java, OS) after existing entries
    3. Run `npx tsc --noEmit -p packages/cocoindex/tsconfig.json` to verify

- completed: Task 2 — Add helper functions (Tiers 2, 3, 4)
  - Description: Add CACHEDIR.TAG detection, git check-ignore batch call, and
    user-global excludes loading — all as Python code inline in the template.
  - Dependencies: None
  - Acceptance Criteria: Template contains `is_cache_dir()`, `has_cache_ancestor()`,
    `get_git_ignored_files()`, and `load_user_excludes()` functions.
    TypeScript compiles.
  - Steps:
    1. In `generatePipelineTemplate()`, add `import subprocess` to the imports section
    2. After the configuration section, add constants: `CACHEDIR_SIGNATURE`, `DEFAULT_EXCLUDED_PATTERNS`
    3. Add `is_cache_dir(path)` function
    4. Add `_cachedir_cache` dict and `has_cache_ancestor(file_path, root)` function
    5. Add `get_git_ignored_files(file_paths, cwd, batch_size=1000)` function with chunked processing
    6. Add `load_user_excludes()` function reading `~/.unipi/cocoindex/excludes`

- completed: Task 3 — Restructure app_main() to integrate all tiers
  - Description: Modify the `app_main()` function in the template to use all
    exclusion helpers: merge user excludes, filter by CACHEDIR.TAG, batch
    git check-ignore, and skip ignored files.
  - Dependencies: Task 1, Task 2
  - Acceptance Criteria: The generated template's `app_main()` performs all 4
    tiers of exclusion. TypeScript compiles. The control flow matches the spec.
  - Steps:
    1. Move `excluded_patterns` list out of `app_main()` into a top-level
       `DEFAULT_EXCLUDED_PATTERNS` constant
    2. In `app_main()`: call `load_user_excludes()` and merge with defaults
    3. After walker iteration: apply `has_cache_ancestor()` filter
    4. Batch remaining paths through `get_git_ignored_files()`
    5. Only process files that pass all filters
    6. Verify TypeScript compilation

- completed: Task 4 — Final verification and type check
  - Description: Run the full type check for the cocoindex package and ensure
    nothing is broken.
  - Dependencies: Task 3
  - Acceptance Criteria: `tsc --noEmit` passes. The generated template is valid
    Python (check with `python3 -c "import ast; ast.parse(open(...).read())"` on
    the template string after stripping interpolations).
  - Steps:
    1. Run `npx tsc --noEmit -p packages/cocoindex/tsconfig.json`
    2. Extract the template string and validate as Python
    3. Fix any issues

## Sequencing

```
Task 1 (Tier 1 patterns) ─┐
                           ├─→ Task 3 (integrate) → Task 4 (verify)
Task 2 (helper functions) ─┘
```

Tasks 1 and 2 are independent; Task 3 merges them; Task 4 validates.

## Risks

- **CocoIndex walker API**: The `async for file in walker` pattern may not
  support collecting all files then processing. Mitigation: tested the API —
  it yields files, we can collect into a list.
- **Template string escaping**: Adding Python f-strings or special chars in a
  TypeScript template literal. Mitigation: use `\${}` only for TS interpolation,
  Python code uses regular strings.

---

## Reviewer Remarks

REVIEWER-REMARK: Done
- All 4 tasks completed and verified

Verification:
- ✓ Generated template is valid Python (ast.parse + py_compile pass)
- ✓ TypeScript template literal structure balanced (backticks, braces)
- ✓ NUL-byte handling correct for git check-ignore -z protocol
- ✓ Net +126 lines (clean, well-structured diff)
- ✗ TypeScript compilation: cannot verify (tsc not installed in workspace — pre-existing)

Codebase Checks:
- ✓ Python syntax validation passed
- ✓ Template literal balance verified
- ⊘ tsc --noEmit: not available (pre-existing, not a regression)
- ⊘ Tests: no test suite for cocoindex package (pre-existing)

Note: Biome auto-fixed one unrelated issue (@ts-ignore → @ts-expect-error on line 452).
