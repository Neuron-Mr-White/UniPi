---
title: "Compactor UX Overhaul — Comprehensive Redesign"
type: brainstorm
date: 2026-04-30
related:
  - .unipi/docs/specs/2026-04-27-compactor-design.md
  - .unipi/docs/specs/2026-04-30-compactor-gap-fixes-design.md
  - .unipi/ralph/compactor-gap-analysis.md
---

# Compactor UX Overhaul — Comprehensive Redesign

## Problem Statement

The compactor package is functionally capable but suffers from:
1. **Dead code** — Security scanner/evaluator exists but is never called. ContentStore is instantiated per-call. Stats return hardcoded zeros. Schema migration uses fragile try/catch without versioning.
2. **Poor agent UX** — 5 skills total ~250 lines of redundant text injected every session. Tool names leak legacy origins (`vcc_`, `ctx_`). No tiered guidance. No proactive context awareness.
3. **Poor user UX** — TUI is bare single-list. Preset names are opaque. Stats are incomplete. No per-project config. No dry-run previews.
4. **Stale config** — 6 pipeline features exist in config but no preset changes them. Strategy modes are rigid. No conditional activation.

**Root need:** A compactor that wastes zero agent tokens on itself, gives agents exactly the guidance they need when they need it, shows users real data, and has no dead wiring.

## Context

The compactor fuses three upstream packages:
- `pi-vcc` — 6-stage zero-LLM compaction pipeline
- `context-mode` — Session continuity, FTS5 search, sandbox execution
- `pi-tool-display` — Diff rendering, bash spinner, thinking labels

A prior gap-fix spec (2026-04-30) documented 4 gaps (auto-index, stats, security, ContentStore singleton). Some fixes were applied, but security wiring and ContentStore singleton remain unresolved.

## Chosen Approach

**Hybrid (Approach C):** Two-tier skill system. Tier 1 (~100 tokens, always loaded) gives the agent just enough to operate. Tier 2 (on-demand) provides detailed patterns and diagnostics. All dead code gets wired. All hardcoded zeros get counters. Tool names get consistent grouping. TUI gets tabs, search, and preset preview. Per-project config added. Presets redesigned with clear names.

## Why This Approach

- **Approach A (Slim & Sharp)** rejected because it strips too much guidance — agent would stumble
- **Approach B (Guide & Guard)** rejected because it injects too many tokens — violates context pressure constraint
- **Hybrid** respects context pressure (minimal tier 1) while giving agent power when needed (tier 2 on-demand)
- Two-tier is the standard pattern in the unipi ecosystem already (workflow skill has main + detail skills)
- Tool renaming is a one-time cost for permanent clarity

---

## Design

### 1. Tool Renaming — Three Consistent Families

All 10 tools get renamed for mnemonic grouping. Old names preserved internally for compatibility but new names are what the agent sees.

| Old (removed from agent view) | New | Family |
|---|---|---|
| `compact` | `compact` | compaction |
| `vcc_recall` | `session_recall` | session |
| `ctx_execute` | `sandbox` | sandbox |
| `ctx_execute_file` | `sandbox_file` | sandbox |
| `ctx_batch_execute` | `sandbox_batch` | sandbox |
| `ctx_index` | `content_index` | content |
| `ctx_search` | `content_search` | content |
| `ctx_fetch_and_index` | `content_fetch` | content |
| `ctx_stats` | `compactor_stats` | compactor |
| `ctx_doctor` | `compactor_doctor` | compactor |
| *(new)* | `context_budget` | compactor |

**Command renames:**

| Old | New |
|---|---|
| `/unipi:compact-recall` | `/unipi:session-recall` |
| `/unipi:compact-index` | `/unipi:content-index` |
| `/unipi:compact-search` | `/unipi:content-search` |
| `/unipi:compact-purge` | `/unipi:content-purge` |
| `/unipi:compact-stats` | keep |
| `/unipi:compact-doctor` | keep |
| `/unipi:compact-settings` | keep |
| `/unipi:compact-preset` | keep |

**Backward compatibility:** Old tool names continue to work for 2 releases. A deprecation notice is logged to debug output when old names are used. The `compact` tool keeps its name (it was already clean).

### 2. Two-Tier Skill System

#### 2.1 Tier 1: `compactor/SKILL.md` (~100 tokens, always loaded)

Condensed from 5 separate skills into 1. Content:

```markdown
# Compactor — Context Management

## When Context Is Tight
- `compact` → free tokens (zero-LLM, 98%+ reduction). Compact BEFORE complex work.
- `compactor_stats` → check savings. `compactor_doctor` → diagnose.

## Finding Past Work
- `session_recall(query)` → search this session (BM25 or regex).
- `content_search(query)` → search indexed files/docs.
  → Index first: `content_index` or `content_fetch(url)`.

## Running Code
- `sandbox(lang, code)` → single script. `sandbox_batch(items)` → atomic.
  `sandbox_file(lang, path)` → run file. Only stdout enters context.

## Complex Multi-Step Tasks
⚠ When the task spans many operations, PREFER Ralph loops
   (`/unipi:work`, `ralph_start`) if available — they manage
   context pressure better than monolithic runs.

## Critical Rules
- Compact BEFORE starting, not when full.
- `session_recall` instead of scrolling history.
- Index project files early if you'll search often.
```

~175 tokens. The agent gets exactly what it needs and nothing more.

#### 2.2 Tier 2: `compactor-detail/SKILL.md` (on-demand, ~400 tokens)

Loaded when agent runs `/unipi:compact-help` or `compactor_doctor`. Contains:
- Full tool parameter reference (from current compactor-tools skill)
- Anti-patterns (don't call compact in a tight loop, don't search without indexing first)
- Sandbox language reference (11 languages, timeout defaults, output caps)
- FTS5 search modes explained (porter/trigram/rrf/fuzzy — when each is best)
- Workflow patterns (research → index → search → sandbox, diagnose → fix → verify)

#### 2.3 Retained Skills

| Skill | Status |
|---|---|
| `compactor` | Rewritten as tier 1 (merge of old compactor + compactor-tools + key patterns) |
| `compactor-detail` | New tier 2 (merge of old compactor-tools + compactor-ops + patterns) |
| `compactor-stats` | Kept as-is (already concise, stats interpretation) |
| `compactor-doctor` | Kept as-is (diagnostics, troubleshooting) |

Old `compactor-tools` and `compactor-ops` are absorbed into `compactor-detail`.

### 3. Dead Code Wiring

#### 3.1 Security Scanner + Evaluator

**Files:** `security/scanner.ts`, `security/evaluator.ts`, `security/policy.ts`

**Current state:** Pure functions that are never called from any hook or handler.

**Wire plan:**
- In the `input` event handler in `index.ts`: after the existing `curl|wget|nc|netcat` regex check, also call `evaluateCommand()` for bash tools, passing deny patterns loaded from `.pi/settings.json`
- In sandbox execution tools (`sandbox`, `sandbox_file`, `sandbox_batch`): before executing, scan non-shell code with `hasShellEscapes()`. If shell escapes found and deny policy matches, return error instead of executing.
- In `tool_result` handler: evaluate file paths from read/write/edit operations against deny patterns using `evaluateFilePath()`. If denied path, log warning.
- **Fail-open:** If security check throws or config is missing, allow the operation through. Hooks are advisory, not enforcement.

#### 3.2 ContentStore Singleton

**Files affected:** `tools/ctx-search.ts`, `tools/ctx-index.ts`, `tools/ctx-fetch-and-index.ts`, `tools/ctx-batch-execute.ts`, `tools/ctx-execute.ts`

**Current state:** Each tool creates `new ContentStore()`, calls `init()`, uses it, `close()`s it. This means:
- Vocabulary for fuzzy correction is rebuilt from scratch every search
- No connection reuse
- WAL file grows without checkpoint

**Fix:** All tools receive the session-level `contentStore` from `CompactorToolDeps`. The singleton is created once in `init()` in `index.ts` and passed through `registerCompactorTools()`. Tool implementations accept it as a parameter.

**Files changed:**
- `tools/ctx-search.ts`: Accept `ContentStore` param, remove internal `new ContentStore()`
- `tools/ctx-index.ts`: Same
- `tools/ctx-fetch-and-index.ts`: Same
- `tools/ctx-batch-execute.ts`: Same
- `tools/register.ts`: Pass `deps.contentStore` to all tool handlers
- `tools/compact.ts` / `tools/vcc-recall.ts` / `tools/ctx-stats.ts` / `tools/ctx-doctor.ts`: Already accept deps indirectly, no change

**WAL checkpoint:** Add periodic checkpoint to `session_shutdown` and after every 10th write operation. `PRAGMA wal_checkpoint(TRUNCATE)`.

#### 3.3 Stats Tracking — Runtime Counters

**Current state:** `sandboxRuns: 0`, `searchQueries: 0` hardcoded in `ctxStats()` and `getInfoScreenData()`.

**Fix:**
- Add `RuntimeCounters` interface to `types.ts`:
  ```typescript
  interface RuntimeCounters {
    sandboxRuns: number;
    searchQueries: number;
    recallQueries: number;
    compactions: number;
    totalTokensCompacted: number;
  }
  ```
- Add counters object to extension state in `index.ts`
- Increment `sandboxRuns` in `sandbox`, `sandbox_file`, `sandbox_batch` tool handlers
- Increment `searchQueries` in `content_search` handler
- Increment `recallQueries` in `session_recall` handler
- `ctxStats()` and `getInfoScreenData()` read from live counters
- Info-screen shows real-time data: "Sandbox runs: 7 this session"

#### 3.4 Schema Migration Hardening

**Current state:** `ALTER TABLE ... ADD COLUMN` with try/catch for "duplicate column" errors. No versioning.

**Fix:**
- Add `PRAGMA user_version` check on init:
  ```typescript
  const currentVersion = this.db.pragma("user_version", { simple: true });
  if (currentVersion < 1) {
    // Run migrations for version 1
    this.migrateAddColumn("session_meta", "total_chars_before INTEGER NOT NULL DEFAULT 0");
    // ... other columns
    this.db.pragma("user_version = 1");
  }
  ```
- Remove try/catch `migrateAddColumn` approach
- Use version-gated migrations that run exactly once
- Add a `runMigrations()` method that checks version and runs all pending migrations in order

### 4. Preset Redesign

#### 4.1 New Preset Names and Behaviors

| Preset | Who For | Key Settings |
|---|---|---|
| **`precise`** | Code-heavy, minimal waste | All compaction on, display hidden/summary, FTS5 manual, sandbox safe-only, pipeline: ttlCache+mmap on, rest off |
| **`balanced`** | Daily use (default) | Moderate all strategies, display balanced, FTS5 auto, sandbox all, pipeline: all on |
| **`thorough`** | Debug/audit | Everything on, full transcript, verbose display, pipeline: all on |
| **`lean`** | Quick fixes, short sessions | Compaction only, display opencode, FTS5 off, sandbox off, pipeline: all off |

#### 4.2 Pipeline Features Per Preset

| Pipeline Feature | precise | balanced | thorough | lean |
|---|---|---|---|---|
| ttlCache | on | on | on | off |
| autoInjection | off | on | on | off |
| proximityReranking | off | on | on | off |
| timelineSort | off | on | on | off |
| progressiveThrottling | off | on | on | off |
| mmapPragma | on | on | on | off |

Currently no preset touches pipeline features — they all inherit defaults. This fixes that.

#### 4.3 Preset Preview in TUI

When user highlights a preset in the TUI, show a 3-line summary of what it changes:
```
precise: Max token savings. Compaction: full. Display: minimal.
         FTS5: manual. Sandbox: safe-only. Pipeline: 2/6 on.
```

### 5. Config Enhancements

#### 5.1 Per-Project Config Overrides

**Path:** `<project-root>/.unipi/config/compactor.json`

**Merge logic:**
1. Load global config (`~/.unipi/config/compactor/config.json`)
2. If project-level config exists, deep-merge: project values override their global counterparts, all other keys inherit from global
3. `detectPreset()` returns `"custom"` if project config is active (since the effective config is no longer a pure preset)

**TUI integration:** Checkbox in settings overlay: "☐ Override for this project". When checked, saves to project-level path.

#### 5.2 Conditional Strategy Activation

Add optional `autoDetect` field to strategy configs:

```typescript
autoDetect?: "git" | null;
```

- `"git"` = only enable this strategy when `.git` directory is detected in project root
- `null` / absent = always use the configured `enabled` value

**Affected strategies:** `commits` (only makes sense with git), `fts5Index` (could auto-enable for large projects).

Implementation: on `session_start`, check `autoDetect` conditions and temporarily disable strategies where the condition isn't met. This is non-destructive — doesn't modify config file, only affects runtime behavior.

#### 5.3 Custom Noise Patterns

Add to config schema:
```typescript
pipeline: {
  // ... existing ...
  customNoisePatterns: string[];  // default: []
}
```

In `filter-noise.ts`, after the hardcoded `NOISE_STRINGS`, also filter blocks matching user-provided patterns. Patterns are regex strings.

### 6. TUI Overhaul

#### 6.1 Tab Navigation

Replace single-list + hidden modes (p/l keys) with proper tabs:

```
┌─ Presets ── Strategies ── Pipeline ───────────────────┐
│                                                        │
│  ● Session Goals                  [full]     [enabled]  │
│  ○ Files & Changes                [all]      [enabled]  │
│  ○ Commits                        [full]     [enabled]  │
│  ○ Outstanding Context            [full]     [enabled]  │
│  ...                                                   │
│                                                        │
│  / search...        ↑↓ nav  Space toggle  ←→ mode     │
│  Tab switch  s save  Esc cancel                        │
└────────────────────────────────────────────────────────┘
```

- **Presets tab:** List of 4 presets with descriptions. Select = apply immediately with preview diff.
- **Strategies tab:** All 10 strategies (debug + 9 strategies). Toggle, cycle modes.
- **Pipeline tab:** 6 pipeline features grouped by context (On Compaction / On Search / On Index).

#### 6.2 Search

`/` key opens a filter bar. Typing filters strategies by name substring match. Only matching items are shown. Backspace clears filter.

#### 6.3 Per-Project Override

Checkbox at bottom of Strategies tab: `☐ Override settings for this project`. Toggling this:
- On: shows "Project override active" in header, saves to project-level path
- Off: shows "Using global config" in header, removes project-level file if it exists

#### 6.4 Stats Footer

Below the tab content, show:
```
Session: 423 events | 3 compactions | 14.2K tokens saved | 12 docs indexed
```
This is read-only, updated every 5 seconds from live counters.

### 7. Performance Optimizations

#### 7.1 BM25 Index Caching

`vcc_recall` (now `session_recall`) rebuilds the BM25 inverted index from scratch on every call. Fix:

- Cache the index in module-level state: `Map<string, number[]>` (term → doc IDs)
- Invalidate cache when `cachedBlocks` changes (detected via length comparison or content hash)
- First call after compaction rebuilds index; subsequent calls in same session reuse cached index
- Expected speedup: 10-50x for repeated queries in large sessions

#### 7.2 WAL Checkpoint Management

- On `session_shutdown`: run `PRAGMA wal_checkpoint(TRUNCATE)`
- Every 10th write operation (insertEvent, upsertResume, etc.): run `PRAGMA wal_checkpoint(PASSIVE)` — non-blocking
- This prevents unbounded WAL growth during long sessions

#### 7.3 Config Serialization Optimization

`detectPreset()` currently does `JSON.stringify` on the full config for comparison. With 4 presets, that's ~5 serializations per open. Fix:

- Pre-compute preset identity hashes (SHA-256 of canonical JSON) at module load time
- Compare via hash, not full serialization
- Only re-serialize if hash check is ambiguous

### 8. Context Budget Awareness

Add a lightweight tool: `context_budget` that returns:

```
Context: ~72% full (estimated 28K tokens remaining)
Session: 847 messages tracked | 3 compactions | last: 14s ago
Advice: Compact before starting complex work (28K may not be enough)
```

Implementation: extracts context window size from Pi's `session_before_compact` event data (which includes `tokensBefore`), estimates remaining budget, returns guidance.

This is added to the tier-1 skill as a known tool.

### 9. Dry-Run Compaction

Add `dryRun: true` parameter to the `compact` tool:

```
compact(dryRun: true)
→ Returns: "Would compact 127 messages → ~18 messages kept (~1.2K tokens).
           Sections: Session Goal (3), Files (8), Commits (2), 
           Outstanding (1), Preferences (4), Brief (42 lines)."
```

Implementation: the compaction pipeline (`compile()`) already returns the summary string. A dry run just runs the pipeline and reports stats without actually registering the compaction with Pi. The `session_before_compact` hook returns the summary but doesn't mark it as a real compaction.

### 10. Auto-Injection Token Budget

**Current:** 500 token hard cap. Builds behavioral_directive + rules + skills + session_mode.

**Proposed:** 150 token hard cap. Builds only:
- `behavioral_directive` (role event) — never dropped
- `session_mode` (intent event) — only if budget remains

Rules and active_skills are dropped from auto-injection. The agent can use `session_recall` to find them if needed. This saves ~350 tokens per compaction cycle.

**Rationale:** The session resume snapshot already preserves all categories. Auto-injection is a convenience, not a necessity. 150 tokens is enough for the two most critical signals (role + intent).

---

## Implementation Checklist

### Phase 1: Dead Code Wiring (P0 fixes)
- [x] Wire security scanner into `input` event handler — evaluateCommand for bash — Task 4
- [x] Wire security scanner into sandbox tools — hasShellEscapes for non-shell code — Task 4
- [x] Wire security evaluator into `tool_result` handler — evaluateFilePath for file ops — Task 4
- [x] Load deny patterns from `.pi/settings.json` on session_start — Task 4
- [x] ContentStore singleton: pass through CompactorToolDeps to all tools — Task 1
- [x] Remove internal `new ContentStore()` from ctx-search, ctx-index, ctx-fetch-and-index, ctx-batch-execute — Task 1
- [x] Add WAL checkpoint to session_shutdown and periodic writes — Task 1
- [x] Schema migration: add PRAGMA user_version, version-gated migrations — Task 2
- [x] Runtime counters: add RuntimeCounters, wire into sandbox/search/recall handlers — Task 3
- [x] Fix ctxStats() and getInfoScreenData() to use live counters — Task 3

### Phase 2: Tool Renaming
- [x] Register all 10 tools under new names (compact, session_recall, sandbox, sandbox_file, sandbox_batch, content_index, content_search, content_fetch, compactor_stats, compactor_doctor) — Task 5
- [x] Keep old names as deprecated aliases (log warning on use) — Task 5
- [x] Rename commands: /unipi:session-recall, /unipi:content-index, /unipi:content-search, /unipi:content-purge — Task 5
- [x] Update command implementations to use new tool function names — Task 5
- [x] Update core constants (COMPACTOR_TOOLS, COMPACTOR_COMMANDS) in @pi-unipi/core — Task 5

### Phase 3: Two-Tier Skills
- [x] Write new tier-1 compactor/SKILL.md (~175 tokens, routing + tools + critical rules + Ralph awareness) — Task 6
- [x] Write new tier-2 compactor-detail/SKILL.md (tool reference + anti-patterns + workflows) — Task 7
- [x] Delete compactor-tools and compactor-ops skill directories (absorbed) — Task 7
- [x] Keep compactor-stats and compactor-doctor as-is — Task 7
- [x] Update package.json pi.skills to reflect new structure — Task 7
- [x] Add `/unipi:compact-help` command that loads tier-2 skill — Task 7

### Phase 4: Preset Redesign
- [x] Rename presets: opencode→precise, balanced→balanced, verbose→thorough, minimal→lean — Task 8
- [x] Update PRESET_CONFIGS with proper pipeline toggles per preset — Task 8
- [x] Update TUI to show new preset names — Task 8
- [x] Update compactor skill to reference new preset names — Task 8
- [x] Backward compat: old preset names still parse (map to new names) — Task 8

### Phase 5: Config Enhancements
- [x] Add per-project config loading in loadConfig() — check `<project>/.unipi/config/compactor.json` — Task 9
- [x] Deep-merge logic: project values override global, rest inherited — Task 9
- [x] Add `autoDetect` field to CompactorStrategyConfig type — Task 9
- [x] Implement autoDetect evaluation in session_start (git detection) — Task 9
- [x] Add `customNoisePatterns` to pipeline config — Task 9
- [x] Wire customNoisePatterns into filter-noise.ts — Task 9

### Phase 6: TUI Overhaul
- [x] Add tab navigation (Presets / Strategies / Pipeline) — Task 10
- [x] Add search/filter (`/` key) — Task 10
- [x] Add preset preview diff on selection — Task 10
- [x] Add per-project override checkbox — Task 10
- [x] Add stats footer with live counters — Task 10
- [x] Show pipeline features grouped by execution context — Task 10

### Phase 7: Performance & Polish
- [x] Cache BM25 inverted index in session_recall (invalidate on blocks change) — Task 11
- [x] Add WAL checkpoint on session_shutdown and periodic writes — Task 1
- [x] Pre-compute preset identity hashes for detectPreset() — Task 11
- [x] Reduce auto-injection token cap from 500→150, drop rules+skills — Task 11
- [x] Add `context_budget` tool — Task 12
- [x] Add `dryRun` parameter to `compact` tool — Task 12

### Phase 8: Backward Compatibility & Cleanup
- [x] Old tool names work with deprecation warning (2 release grace) — Task 13
- [x] Old preset names map to new names — Task 13
- [x] Old command names work with deprecation notice — Task 13
- [x] Update README.md with new tool/command names — Task 13
- [x] Update package.json version — Task 13
- [x] Run full test suite — Task 13
- [x] Run compactor-doctor diagnostics — Task 13

---

## Open Questions

1. **Ralph loop for Phase 7 performance optimizations?** The BM25 caching and preset hash pre-computation are independent optimizations that could benefit from a Ralph loop for parallel testing.

2. **Tier-2 skill auto-loading?** Should the agent automatically load tier-2 when it encounters errors (tool failures, context warnings), or only when explicitly asked? Recommendation: manual only (`/unipi:compact-help`). Auto-loading adds complexity and the tier-1 skill has enough to self-diagnose.

3. **Per-project config schema?** Should project-level config be a full CompactorConfig or a partial overrides-only schema? Recommendation: partial overrides — only the keys that differ from global. Simpler, smaller files, easier to reason about.

## Out of Scope

- Analytics engine (context-mode's 90-metric dashboard) — too complex, our stats are sufficient
- Network I/O tracking in sandbox — low value, high complexity
- sqlite-vec integration — memory package's domain
- Multi-session aggregation — current session only
- Auto-loading tier-2 skills — manual only
- GUI/external dashboard — everything stays in TUI

## Ralph Loop Plan

For implementation, use a Ralph loop with these passes:

```
ralph_start:
  name: compactor-ux-overhaul
  taskContent: |
    ## Goal: Full compactor UX overhaul with 8 phases
    
    ### Pass 1: Dead Code Wiring
    - [ ] Wire security scanner/evaluator
    - [ ] ContentStore singleton
    - [ ] Schema migration hardening
    - [ ] Runtime counters
    
    ### Pass 2: Tool Renaming
    - [ ] Register new tool names, alias old names
    - [ ] Rename commands
    - [ ] Update core constants
    
    ### Pass 3: Two-Tier Skills
    - [ ] Write tier-1 SKILL.md
    - [ ] Write tier-2 SKILL.md
    - [ ] Delete absorbed skills
    
    ### Pass 4: Preset Redesign
    - [ ] New preset names + pipeline toggles
    - [ ] Update TUI + skill references
    
    ### Pass 5: Config Enhancements
    - [ ] Per-project config
    - [ ] autoDetect
    - [ ] customNoisePatterns
    
    ### Pass 6: TUI Overhaul
    - [ ] Tabs, search, preset preview, project override, stats footer
    
    ### Pass 7: Performance & Polish
    - [ ] BM25 cache, WAL checkpoint, preset hashes
    - [ ] Auto-injection token reduction
    - [ ] context_budget tool, dryRun parameter
    
    ### Pass 8: Compatibility & Cleanup
    - [ ] Deprecation aliases, README, tests
  itemsPerIteration: 0
  reflectEvery: 2
  maxIterations: 12
```

## Decision Rationale

- **Why rename tools?** `vcc_` and `ctx_` prefixes leak implementation origins. The agent doesn't know or care that recall came from pi-vcc. Consistent families (`sandbox_*`, `content_*`, `compactor_*`, `session_*`) make the system predictable.
- **Why 150 tokens for auto-injection?** The 500-token cap was inherited from context-mode without reconsideration. The session resume snapshot (XML) already preserves all categories. Auto-injection is a convenience — behavioral_directive (role) is the only must-have. session_mode provides context awareness. Everything else is findable via session_recall.
- **Why two-tier skills instead of one?** A single skill would either be too long (wastes tokens) or too short (leaves agent helpless). Two-tier gives both: minimum viable guidance always loaded, deep reference on demand.
- **Why per-project config as partial overrides?** Full config per project duplicates 95% of global settings. Partial overrides are concise, merge cleanly, and don't break when global defaults change.
- **Why preset names 'precise/thorough' instead of 'opencode/verbose'?** Users understand what "precise" and "thorough" mean in daily language. "Opencode" only makes sense if you know pi-tool-display's history.
