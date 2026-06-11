---
title: "CocoIndex: Extract Python Template to Standalone File"
type: brainstorm
date: 2026-06-11
---

# CocoIndex: Extract Python Template to Standalone File

## Problem Statement

The CocoIndex pipeline template is a ~280-line Python script embedded as a
TypeScript template literal in `bridge.ts`. This makes it impossible to:
- Run Python linters (ruff, mypy, pyright) on it
- Get IDE support (syntax highlighting, autocomplete) while editing
- Run type checkers or unit tests against the Python logic
- Easily review the Python code in PRs (it's buried inside TS)

## Context

The template has only **5 interpolation points**, all trivial substitutions:
1. `${projectBasename}` — project name (4 occurrences)
2. `${projectDir}` — absolute path to project root (1 occurrence)

These are simple string replacements, not complex logic.

## Approaches

### Approach A: `.py` file with placeholder strings + `readFileSync` + replace

```
packages/cocoindex/
├── bridge.ts            (reads template, does substitution)
├── pipeline-template.py (the actual Python, lintable)
└── package.json         (add "pipeline-template.py" to files[])
```

**bridge.ts:**
```typescript
function generatePipelineTemplate(projectDir: string, _embeddingConfig: EmbeddingConfig): string {
  const projectBasename = projectDir.split("/").pop() ?? "project";
  const templatePath = join(__dirname, "pipeline-template.py");
  let template = readFileSync(templatePath, "utf-8");
  template = template.replaceAll("{{PROJECT_BASENAME}}", projectBasename);
  template = template.replaceAll("{{PROJECT_DIR}}", projectDir);
  return template;
}
```

**pipeline-template.py** uses `{{PROJECT_BASENAME}}` and `{{PROJECT_DIR}}`
placeholders (double-brace to avoid Python f-string/format conflicts).

**Pros:**
- ✅ Full Python tooling: ruff, mypy, pyright, pytest
- ✅ IDE support when editing the `.py` file
- ✅ Clean PR diffs (Python changes in .py, TS changes in .ts)
- ✅ Can run `python3 pipeline-template.py` for basic smoke testing
- ✅ Simple implementation — just `readFileSync` + `replaceAll`

**Cons:**
- ⚠️ `__dirname` doesn't exist in ESM (need `import.meta.url` workaround)
- ⚠️ The placeholders make the `.py` not directly runnable without substitution
- ⚠️ Extra file to include in `package.json` → `files` array

### Approach B: `.py.template` file (same as A but different extension)

Same as A, but use `pipeline.py.template` extension.

**Pros:**
- ✅ Makes it obvious this isn't a regular Python file
- ✅ Won't accidentally be imported/executed

**Cons:**
- ❌ Loses IDE Python language support (editors won't apply Python mode to .template)
- ❌ No ruff/mypy/pyright support without extra config
- ❌ Defeats the main purpose

### Approach C: Valid Python with `os.environ` defaults (no placeholders)

Make the template a fully valid, runnable `.py` file that reads its
configuration from environment variables with sensible defaults:

```python
PROJECT_BASENAME = os.environ.get("PROJECT_BASENAME", "project")
PROJECT_DIR = os.environ.get("PROJECT_DIR", os.getcwd())
```

At scaffold time, `bridge.ts` reads the file and replaces these lines with
hardcoded values:

```python
PROJECT_BASENAME = "my-actual-project"
PROJECT_DIR = "/Users/foo/my-actual-project"
```

**Pros:**
- ✅ 100% valid Python — runs, lints, type-checks as-is
- ✅ Can test with `PROJECT_BASENAME=test python3 pipeline-template.py`
- ✅ Full IDE support
- ✅ ruff/mypy/pyright work without any workarounds

**Cons:**
- ⚠️ The substitution is line-based (slightly more fragile than token replace)
- ⚠️ Need to keep the env-var lines in a specific format for the regex

### Approach D: Hybrid — `.py` file with marker comments

```python
# %%COCOINDEX_TEMPLATE_VAR:PROJECT_BASENAME%%
PROJECT_BASENAME = "project"  # placeholder
# %%COCOINDEX_TEMPLATE_VAR:PROJECT_DIR%%
PROJECT_DIR = os.getcwd()  # placeholder
```

bridge.ts finds lines after marker comments and replaces them.

**Pros:**
- ✅ Valid Python, runs with defaults
- ✅ Explicit markers make substitution robust

**Cons:**
- ⚠️ Ugly marker comments
- ⚠️ Over-engineered for 5 simple substitutions

## Recommendation: Approach A (`.py` file with `{{placeholders}}`)

Reasons:
1. **Simplest mental model** — placeholders are obvious, substitution is `replaceAll`
2. **The file won't be run directly** — it's scaffolded into a project, so
   being "not quite runnable" without substitution is fine
3. **Python tooling still works** — ruff/mypy handle the placeholder strings as
   regular string literals (they just contain `{{...}}` text, which is valid Python)
4. **ESM __dirname** is solvable with a one-liner:
   ```typescript
   import { fileURLToPath } from "node:url";
   const __dirname = fileURLToPath(new URL(".", import.meta.url));
   ```

Actually — wait. The `{{PROJECT_BASENAME}}` placeholders would appear inside
Python string literals like `"lancedb/{{PROJECT_BASENAME}}"`. That IS valid
Python (it's just a string containing braces). ruff/mypy won't complain.

But for **pyright type checking** to work fully, and for the script to be
testable, Approach C is actually better. Let me reconsider.

## Revised Recommendation: Approach C (valid Python with env-var defaults)

The file is 100% valid Python. At scaffold time we do simple line replacement.
For linting/testing, we just run it with env vars or use the defaults.

**Implementation:**

**`packages/cocoindex/pipeline-template.py`:**
```python
"""CocoIndex pipeline template. ..."""
import os
...
# ── Template Configuration (replaced at scaffold time) ───
PROJECT_BASENAME = os.environ.get("COCO_PROJECT_BASENAME", "project")
PROJECT_DIR = os.environ.get("COCO_PROJECT_DIR", os.getcwd())
...
# Rest of the file uses PROJECT_BASENAME and PROJECT_DIR
db_key = coco.ContextKey(f"lancedb/{PROJECT_BASENAME}")
```

**`bridge.ts`:**
```typescript
function generatePipelineTemplate(projectDir: string): string {
  const projectBasename = projectDir.split("/").pop() ?? "project";
  const templatePath = new URL("pipeline-template.py", import.meta.url);
  let template = readFileSync(templatePath, "utf-8");
  // Hardcode values for the scaffolded copy
  template = template.replace(
    /^PROJECT_BASENAME = .+$/m,
    `PROJECT_BASENAME = "${projectBasename}"`
  );
  template = template.replace(
    /^PROJECT_DIR = .+$/m,
    `PROJECT_DIR = "${projectDir}"`
  );
  return template;
}
```

**Testing:**
```bash
cd packages/cocoindex
ruff check pipeline-template.py
mypy pipeline-template.py --ignore-missing-imports
python3 -c "import ast; ast.parse(open('pipeline-template.py').read())"
```

## Implementation Checklist

- [ ] Create `packages/cocoindex/pipeline-template.py` from current template
- [ ] Use env-var defaults for PROJECT_BASENAME and PROJECT_DIR
- [ ] Update `bridge.ts` → `generatePipelineTemplate()` to read + substitute
- [ ] Add `pipeline-template.py` to `package.json` files array
- [ ] Add `ruff check` / `python3 -m py_compile` to test/CI script
- [ ] Remove the inline template literal from `bridge.ts`
- [ ] Verify scaffolding still works (generated main.py identical)

## Open Questions

- Should we add a `pyproject.toml` in `packages/cocoindex/` for ruff config?
- Should the template doc-comment reference where it came from?

## Out of Scope

- Changing the CocoIndex walker API
- Adding Python tests that import cocoindex (not available in this repo)
