---
title: "@pi-unipi/compactor — Context Engine"
type: brainstorm
date: 2026-04-27
participants: [user, MiMo]
related:
  - docs/specs/2026-04-26-unipi-architecture-brainstorm.md
  - https://github.com/sting8k/pi-vcc
  - https://github.com/mksglu/context-mode
  - https://github.com/MasuRii/pi-tool-display
---

# @pi-unipi/compactor — Context Engine

> The context engine that fuses the best of pi-vcc, context-mode, and pi-tool-display into a single, deeply configurable, unipi-native package.

## Problem Statement

Context window exhaustion is the #1 productivity killer in long coding sessions. Three categories of pain exist:

1. **Compaction pain** — Pi's built-in compaction strips too much context, requires LLM calls (slow + costly), loses session continuity across compactions.
2. **Large output pain** — Reading files, running tests, calling APIs floods context with raw data. Users manually pipe through `head` or `grep`, losing the full picture.
3. **Display pain** — Tool output is verbose by default. Diffs, bash output, thinking blocks consume massive visual and token space.

**Root need:** A single context engine that compacts intelligently, preserves session continuity, enables sandboxed analysis of large outputs, and renders context efficiently — all configurable per-strategy, all working together.

## Context

### What We Studied

Three packages were downloaded to `/tmp/` and analyzed in depth:

| Package | Lines | Core Value |
|---|---|---|
| `pi-vcc` (~2.4K lines) | Zero-LLM algorithmic compaction via 6-stage pipeline. 98%+ token reduction. BM25-lite recall. Session lineage. |
| `context-mode` (~50K+ lines) | Sandbox execution (11 langs), FTS5 search engine, session continuity (15 event categories), security hardening, compaction survival via XML resume snapshots. |
| `pi-tool-display` (~8.5K lines) | Diff rendering engine (LCS-based), bash spinner + elapsed time, thinking labels, user message box, pending diff previews, presets system. |

### What We Already Have

The unipi ecosystem already provides:
- `@pi-unipi/memory` — persistent memory with vector + fuzzy search
- `@pi-unipi/mcp` — MCP server management
- `@pi-unipi/info-screen` — module status dashboard with reactive groups
- `@pi-unipi/utility` — utility features (KEEP UNTOUCHED per user direction)
- `@pi-unipi/ask-user` — TUI settings overlay pattern (for us to learn from)

## Chosen Approach

**Single package `@pi-unipi/compactor`** that absorbs ALL context-related features from the three source packages, excluding:
- MCP server/client (we have `@pi-unipi/mcp`)
- Multi-platform adapters (we're Pi-only)
- Anything that belongs in `@pi-unipi/utility` (untouched)

Each compaction strategy is **toggleable** (on/off) and **cyclable** (per-strategy presets for granular control). Configuration lives in `~/.unipi/config/compactor/`. Stats register with `@pi-unipi/info-screen` if present.

## What We're Fusing (Complete Feature Inventory)

### From pi-vcc — Zero-LLM Compaction Engine

| Feature | Lines | Status |
|---|---|---|
| 6-stage pipeline (Normalize → Filter Noise → Build Sections → Brief Transcript → Format → Merge) | ~600 | 🔀 FUSE |
| Session Goal extraction (regex-based, scope changes, task verbs) | 79 | 🔀 FUSE |
| Files & Changes tracking (Modified/Created/Read, dedup, path trimming) | 80 | 🔀 FUSE |
| Commit extraction (git commit parsing, hash pairing, last 8) | 69 | 🔀 FUSE |
| Outstanding Context / Blockers | build-sections.ts | 🔀 FUSE |
| User Preferences extraction | 79 | 🔀 FUSE |
| Brief Transcript (truncated user/assistant/tool lines, rolling window) | 381 | 🔀 FUSE |
| Noise filtering (thinking blocks, noise tools, XML wrappers, stop words) | filter-noise.ts | 🔀 FUSE |
| Rolling window capBrief() at 120 lines | brief.ts | 🔀 FUSE |
| Orphan recovery | before-compact.ts | 🔀 FUSE |
| BM25-lite recall search | search-entries.ts | 🔀 FUSE |
| Session lineage tracking | lineage.ts | 🔀 FUSE |
| vcc_recall tool | 109 | 🔀 FUSE |
| Settings scaffolding | 77 | 🔀 FUSE |
| Diagnostics report | 237 | 🔀 FUSE |
| 20 test files | tests/ | 🔀 FUSE |

### From context-mode — Session Continuity & Execution

| Feature | Lines | Status |
|---|---|---|
| Session event tracking (15 categories: Files, Tasks, Rules, Decisions, Git, Errors, Environment, MCP tools, Subagents, Skills, Role, Intent, Data, Plan, User Prompts) | session/ | 🔀 FUSE |
| Compaction survival — XML resume snapshot (≤2KB) | snapshot.ts | 🔀 FUSE |
| Session Guide — 14-category structured resume | snapshot.ts | 🔀 FUSE |
| FTS5 Search Engine (SQLite dual-index: porter + trigram, RRF, proximity reranking, fuzzy correction) | ContentStore | 🔀 FUSE |
| Content indexing/chunking (markdown by headings, JSON recursive, plain text) | chunking/ | 🔀 FUSE |
| `ctx_execute` — 11 languages, only stdout enters context | execute.ts | 🔀 FUSE |
| `ctx_execute_file` — file loads via FILE_CONTENT, never touches context | execute.ts | 🔀 FUSE |
| `ctx_batch_execute` — atomic batch of commands + searches | batch.ts | 🔀 FUSE |
| Content auto-refresh (mtime + SHA-256 detection) | ContentStore | 🔀 FUSE |
| TTL cache for fetched URLs (24h) | fetch.ts | 🔀 FUSE |
| Stale cleanup (14-day old DBs) | lifecycle.ts | 🔀 FUSE |
| Security: bash deny policy, chained command splitting, shell-escape scanning (Python/JS/Ruby/Go/PHP/Rust), path deny patterns, env var sanitization (50+ vars), 100MB output cap | security/ | 🔀 FUSE |
| Process lifecycle: parent PID polling (30s), orphan check, signal handlers | lifecycle.ts | 🔀 FUSE |
| Analytics dashboard (stats, insight) | analytics.ts | 🔀 FUSE |
| **EXCLUDED:** MCP server, multi-platform adapters (14 platforms), hooks/ shell scripts | — | ❌ SKIP |

### From pi-tool-display — Tool Rendering

| Feature | Lines | Status |
|---|---|---|
| Diff rendering engine (3 layouts: auto/split/unified, 3 indicators: bars/classic/none) | 2561 | 🔀 FUSE |
| Syntax highlighting + inline diff emphasis (LCS token diff) | diff-renderer.ts | 🔀 FUSE |
| Bash spinner (braille animation 80ms) + elapsed time | 149 | 🔀 FUSE |
| Thinking labels (themed prefix, context sanitization) | 313 | 🔀 FUSE |
| User message box (bordered `╭─ user ─╮`, markdown-aware) | user-message-box-*.ts | 🔀 FUSE |
| Pending diff previews (edit/overwrite/create during streaming) | 305 | 🔀 FUSE |
| Edit projection with single-match validation + overlap detection | pending-diff-preview.ts | 🔀 FUSE |
| 3 presets (opencode/balanced/verbose) + custom detection | presets.ts | 🔀 FUSE |
| Settings inspector UI (split-pane, search, keyboard nav) | settings-inspector-modal.ts | 🔀 FUSE |
| Nerd Font detection | modal-icons.ts | 🔀 FUSE |
| Width clamping, collapsed hints, compact/summary modes | line-width-safety.ts | 🔀 FUSE |
| **EXCLUDED:** MCP wrapping (we have `@pi-unipi/mcp`) | — | ❌ SKIP |

### Skills To Ship

We will ship the following skills with the package:

| Skill | Source | Role |
|---|---|---|
| `compactor` (main) | Derived from context-mode/SKILL.md | Routing decision tree for compaction + sandbox usage |
| `compactor-ops` | Derived from context-mode-ops | Engineering ops: triage, PR review, release (parallel subagent army) |
| `compactor-stats` | Derived from ctx-stats | Stats display skill |
| `compactor-doctor` | Derived from ctx-doctor | Diagnostics skill |
| `compactor-tools` | Adapted from pi-vcc + context-mode | Reference for all available tools and when to use them |

### Commands

All commands use `/unipi:` prefix per convention:

| Command | Description |
|---|---|
| `/unipi:compact` | Manual compaction on demand |
| `/unipi:compact-recall` | Search session history with pagination |
| `/unipi:compact-stats` | Show context savings dashboard |
| `/unipi:compact-doctor` | Run diagnostics |
| `/unipi:compact-settings` | Open TUI settings overlay |
| `/unipi:compact-preset <opencode\|balanced\|verbose>` | Apply quick preset |
| `/unipi:compact-index` | Index current project content into FTS5 |
| `/unipi:compact-search` | Search indexed content |
| `/unipi:compact-purge` | Wipe all indexed content |

### Tools

| Tool | Description |
|---|---|
| `compact` | Trigger manual compaction with stats |
| `vcc_recall` | Search session history (BM25/regex/pagination/expand) |
| `ctx_execute` | Run code in 11 languages, only stdout enters context |
| `ctx_execute_file` | Process file in sandbox via FILE_CONTENT variable |
| `ctx_batch_execute` | Atomic batch of commands + searches |
| `ctx_index` | Chunk content → index into FTS5 |
| `ctx_search` | Query indexed content (BM25 + trigram + fuzzy) |
| `ctx_fetch_and_index` | Fetch URL → markdown → index |
| `ctx_stats` | Context savings dashboard |
| `ctx_doctor` | Diagnostics checklist |

## Configurable Compaction Strategies

Every strategy can be **toggled on/off** AND has **cycle values** for granular control:

### Strategy Configuration Schema

```typescript
interface CompactorStrategyConfig {
  enabled: boolean;           // Toggle on/off
  mode: string;               // Current cycle value
}

interface CompactorConfig {
  // === Compaction Strategies ===
  sessionGoals: CompactorStrategyConfig & {
    mode: "full" | "brief" | "off";  // full: 6 lines + scope changes, brief: 3 lines, off: skip
  };
  filesAndChanges: CompactorStrategyConfig & {
    mode: "all" | "modified-only" | "off";  // Track created/read/modified or just modified
    maxPerCategory: number;  // 5-20
  };
  commits: CompactorStrategyConfig & {
    mode: "full" | "brief" | "off";  // full: message+hash, brief: message only
    maxCommits: number;      // 5-15
  };
  outstandingContext: CompactorStrategyConfig & {
    mode: "full" | "critical-only" | "off";  // critical: only "failed" / "broken", full: all blockers
    maxItems: number;        // 3-10
  };
  userPreferences: CompactorStrategyConfig & {
    mode: "all" | "recent-only" | "off";  // recent: last 3 turns only
    maxPreferences: number;  // 5-20
  };
  briefTranscript: CompactorStrategyConfig & {
    mode: "full" | "compact" | "minimal" | "off";  // Lines: 120 / 60 / 20
    userTokenLimit: number;  // 128-512
    assistantTokenLimit: number; // 100-400
    toolCallLimit: number;   // 4-16 per turn
  };
  sessionContinuity: CompactorStrategyConfig & {
    mode: "full" | "essential-only" | "off";  // essential: Files+Tasks+Errors only
    eventCategories: string[];  // Subset of 15 categories when not full
  };
  fts5Index: CompactorStrategyConfig & {
    mode: "auto" | "manual" | "off";  // auto: index on session start
    chunkSize: number;       // 1KB-8KB
    cacheTtlHours: number;   // 1-72
  };
  sandboxExecution: CompactorStrategyConfig & {
    mode: "all" | "safe-only" | "off";  // safe: no network/file ops
    allowedLanguages: string[];  // Subset of 11
    outputLimit: number;     // 1MB-100MB
  };
  toolDisplay: CompactorStrategyConfig & {
    mode: "opencode" | "balanced" | "verbose" | "custom";
    diffLayout: "auto" | "split" | "unified";
    diffIndicator: "bars" | "classic" | "none";
    showThinkingLabels: boolean;
    showUserMessageBox: boolean;
    showBashSpinner: boolean;
    showPendingPreviews: boolean;
  };

  // === Global Settings ===
  overrideDefaultCompaction: boolean;  // Handle all /compact and auto-threshold paths
  debug: boolean;  // Write metrics to /tmp/
  showTruncationHints: boolean;
}
```

### Presets

Each preset adjusts ALL strategies at once:

| Preset | Description |
|---|---|
| `opencode` (default) | All on, opencode mode — maximal context preservation, minimal display |
| `balanced` | Moderate across all — good default for most sessions |
| `verbose` | All on, verbose mode — everything visible, everything tracked |
| `minimal` | Only compaction + basic recall — fastest, least overhead |
| `custom` | User-defined — detected when settings don't match any preset |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  @pi-unipi/compactor                                            │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ Compaction Core │  │ Session Engine  │  │ Display Engine  │  │
│  │ (from pi-vcc)   │  │ (from ctx-mode) │  │ (from tool-dsp) │  │
│  │                 │  │                 │  │                 │  │
│  │ • 6-stage pipe  │  │ • 15 event cats │  │ • Diff renderer │  │
│  │ • Goal extract  │  │ • FTS5 search   │  │ • Bash spinner  │  │
│  │ • File tracking │  │ • Sandbox exec  │  │ • Thinking lbl  │  │
│  │ • Brief trans.  │  │ • Security      │  │ • Msg box       │  │
│  │ • Noise filter  │  │ • Lifecycle     │  │ • Presets       │  │
│  │ • Recall (BM25) │  │ • Analytics     │  │                 │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │            │
│           └────────────────────┼────────────────────┘            │
│                                ▼                                 │
│                    ┌─────────────────────┐                       │
│                    │   Config Manager    │                       │
│                    │  ~/.unipi/config/   │                       │
│                    │    compactor/       │                       │
│                    └─────────────────────┘                       │
│                                │                                 │
│                    ┌───────────┴───────────┐                     │
│                    ▼                       ▼                     │
│           ┌─────────────┐        ┌─────────────────┐             │
│           │ TUI Overlay │        │ Info-Screen Reg │ (optional)  │
│           │ (/unipi:    │        │ if @pi-unipi/   │             │
│           │  compact-   │        │ info-screen     │             │
│           │ settings)   │        │ present)        │             │
│           └─────────────┘        └─────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Session Start** → Load config → Initialize SQLite (session DB + content store) → Announce module via `unipi:module:ready` → Register info-screen group if present
2. **During Session** → Capture events (15 categories) → Session DB with dedup + FIFO eviction
3. **Tool Calls** → Custom renderers apply output mode logic (hidden/summary/preview)
4. **Before Compact** → Build resume snapshot (XML, ≤2KB) from session events + pi-vcc summary
5. **Compact** → pi-vcc pipeline with enabled strategies only → merge with previous summary
6. **After Compact** → Stats toast → Update info-screen data → Emit `unipi:info:data:updated`
7. **Session Cont. Post-Compact** → Retrieve snapshot → Re-inject as Session Guide

## Pi Event Hooks

| Event | Handler | Source |
|---|---|---|
| `session_start` | Init DB, load config, announce module, wrap MCP tools (if present) | compactor |
| `before_agent_start` | Refresh capabilities, re-wrap MCP tools | compactor |
| `session_before_compact` | Build resume snapshot + run pi-vcc compaction | pi-vcc + context-mode |
| `session_compact` | Post-compaction stats, increment counter | context-mode |
| `session_shutdown` | Cleanup old sessions (7 days) | context-mode |
| `tool_call` | PreToolUse routing enforcement (block curl/wget in bash) | context-mode |
| `tool_result` | PostToolUse event capture → Session DB | context-mode |
| `message_update` | Thinking label formatting during streaming | pi-tool-display |
| `message_end` | Thinking label persistence on final message | pi-tool-display |
| `context` | Sanitize presentation artifacts before next LLM turn | pi-tool-display |

## Info-Screen Integration

If `@pi-unipi/info-screen` is present, register a `compactor` info group:

```typescript
infoRegistry.registerGroup({
  id: "compactor",
  name: "Compactor",
  icon: "🗜️",
  priority: 30,
  config: {
    showByDefault: true,
    stats: [
      { id: "sessionEvents", label: "Session Events", show: true },
      { id: "compactions", label: "Compactions", show: true },
      { id: "tokensSaved", label: "Tokens Saved", show: true },
      { id: "compressionRatio", label: "Compression", show: true },
      { id: "indexedDocs", label: "Indexed Docs", show: true },
      { id: "sandboxExecutions", label: "Sandbox Runs", show: true },
      { id: "searchQueries", label: "Searches", show: true },
    ],
  },
  dataProvider: async () => ({
    sessionEvents: { value: "1,247", detail: "15 categories tracked" },
    compactions: { value: "3", detail: "Last: 14s ago" },
    tokensSaved: { value: "42.3K", detail: "98.2% reduction" },
    compressionRatio: { value: "56:1", detail: "avg across sessions" },
    indexedDocs: { value: "12", detail: "3 sources, 87 chunks" },
    sandboxExecutions: { value: "23", detail: "11 languages available" },
    searchQueries: { value: "8", detail: "4 BM25, 4 regex" },
  }),
});
```

## Configuration Storage

- **Path:** `~/.unipi/config/compactor/config.json`
- **Format:** JSON with schema validation
- **Migration:** Auto-upgrades from older versions, fills missing keys with defaults
- **UI:** TUI overlay via `/unipi:compact-settings` (learned from `@pi-unipi/ask-user` pattern)

## Database Backends (from context-mode)

| Backend | When Used |
|---|---|
| `bun:sqlite` | Bun runtime detected |
| `node:sqlite` | Node.js >= 22.13 on Linux |
| `better-sqlite3` | Everything else (optional dependency) |

Both databases use prepared statement caching and lazy singleton pattern.

## Security Model

| Layer | Protection |
|---|---|
| Bash deny policy | Reads `.pi/settings.json` deny patterns |
| Chained command splitting | Prevents `&&` / `\|\|` bypass |
| Shell-escape scanning | Detects subprocess calls in Python/JS/Ruby/Go/PHP/Rust |
| Path deny patterns | Blocks dangerous paths, prevents symlink escape |
| Env var sanitization | Strips 50+ dangerous vars |
| Output cap | 100MB max per execution |
| Network tracking | Intercepts fetch/http/https in sandbox |
| FS read tracking | Intercepts readFileSync in sandbox |

## Skills Architecture

Skill files live in `packages/compactor/skills/`:

```
skills/
  compactor/
    SKILL.md              # Main routing skill
    references/
      anti-patterns.md    # Common mistakes
      patterns-js.md      # JS/TS sandbox patterns
      patterns-py.md      # Python sandbox patterns
      patterns-sh.md      # Shell sandbox patterns
  compactor-tools/
    SKILL.md              # Tool reference card
  compactor-ops/
    SKILL.md              # Engineering ops orchestration
    agent-teams.md        # Domain-specific agent teams
    communication.md      # Communication templates
    marketing.md          # LinkedIn posts, announcements
    release.md            # Release workflow
    review-pr.md          # PR review workflow
    tdd.md                # TDD methodology
    triage-issue.md       # Issue triage workflow
    validation.md         # Claim verification
  compactor-stats/
    SKILL.md
  compactor-doctor/
    SKILL.md
```

## Implementation Checklist

> All items below are covered by the implementation plan at `.unipi/docs/plans/2026-04-27-compactor-plan.md`.
> `[x]` = planned (covered by plan). Implementation progress tracked in plan file, not here.

- [x] Core constants (MODULES, TOOLS, COMMANDS, COMPACTOR_DIRS) in `@pi-unipi/core` — Task 1
- [x] Config schema + storage (`~/.unipi/config/compactor/config.json`) — Task 2
- [x] Config migration (fills missing keys from defaults) — Task 2
- [x] TUI settings overlay (up/down navigate, Space toggle mode, Enter save, Esc cancel) — Task 3
- [x] Preset system (opencode, balanced, verbose, minimal, custom) — Task 2
- [x] Stage 1: Normalize — Message[] → NormalizedBlock[] — Task 4
- [x] Stage 2: Filter Noise — Remove thinking, noise tools, XML, stop words — Task 4
- [x] Stage 3: Build Sections — Goals, Files, Commits, Blockers, Preferences — Task 4
- [x] Stage 4: Brief Transcript — Truncate, collapse tool calls, cap at 120 lines — Task 5
- [x] Stage 5: Format — Render sections with separators — Task 5
- [x] Stage 6: Merge — Merge with previous summary, dedup, rolling window — Task 5
- [x] Cut logic — buildOwnCut(), orphan recovery, compact-all — Task 6
- [x] Session event tracking (15 categories) with SQLite session DB — Task 8
- [x] Compaction survival — XML resume snapshot builder — Task 9
- [x] Session Guide — 14-category structured recap — Task 9
- [x] FTS5 content store with dual-index (porter + trigram) — Task 10
- [x] Content indexing — markdown headings, JSON recursive, plain text — Task 10
- [x] BM25 search engine with RRF + proximity reranking + fuzzy correction — Task 10
- [x] Sandbox executor — 11 language runtimes, process isolation, Bun auto-detect — Task 11
- [x] `ctx_execute` tool — Task 16
- [x] `ctx_execute_file` tool — Task 16
- [x] `ctx_batch_execute` tool — Task 16
- [x] `ctx_index` tool — Task 16
- [x] `ctx_search` tool — Task 16
- [x] `ctx_fetch_and_index` tool — Task 16
- [x] `ctx_stats` tool — Task 16
- [x] `ctx_doctor` tool — Task 16
- [x] `vcc_recall` tool — Task 7
- [x] `compact` tool — Task 16
- [x] Bash deny policy + chained command splitting — Task 12
- [x] Shell-escape scanning (Python/JS/Ruby/Go/PHP/Rust) — Task 12
- [x] Path deny patterns with symlink escape prevention — Task 12
- [x] Env var sanitization (50+ dangerous vars) — Task 11
- [x] Output cap enforcement (100MB) — Task 11
- [x] Diff rendering engine (3 layouts, 3 indicators, syntax highlighting) — Task 14
- [x] Inline diff emphasis (LCS token diff) — Task 14
- [x] Bash spinner animation + elapsed time — Task 13
- [x] Thinking labels with context sanitization — Task 15
- [x] User message box (bordered, markdown-aware) — Task 15
- [x] Pending diff previews (edit/overwrite/create projection) — Task 15
- [x] Nerd Font detection — Task 13 (display engine)
- [x] Width clamping, collapsed hints — Task 14
- [x] Info-screen group registration (if `@pi-unipi/info-screen` present) — Task 19
- [x] Event hooks (session_start, before_agent_start, before_compact, compact, shutdown, tool_call, tool_result, message_update, message_end, context) — Task 18
- [x] Commands: /unipi:compact, /unipi:compact-recall, /unipi:compact-stats, /unipi:compact-doctor, /unipi:compact-settings, /unipi:compact-preset, /unipi:compact-index, /unipi:compact-search, /unipi:compact-purge — Task 17
- [x] Skills: compactor, compactor-tools, compactor-ops, compactor-stats, compactor-doctor — Task 20
- [x] Process lifecycle (parent PID polling, orphan check, signal handlers, stale cleanup) — covered in utilities plan
- [x] Testing: comprehensive test suite (follow pi-vcc's 20+ test files pattern) — Task 22
- [x] Ralph requirement: verify by iterating through downloaded source packages — Task 0 (Ralph loop)

## Ralph Wiggum Cycle Requirement

Per user request, the **implementation MUST** use Ralph loop to cycle through the three downloaded packages (`/tmp/pi-vcc`, `/tmp/context-mode`, `/tmp/pi-tool-display`) to verify nothing is missed:

```
ralph_start:
  name: compactor-audit-source-packages
  taskContent: |
    ## Goal: Audit all three source packages for missed features

    ### Package 1: /tmp/pi-vcc
    - [ ] List every .ts file
    - [ ] Compare against our feature list — what's missing?
    - [ ] Check tests/ for edge cases we should handle
    - [ ] Note any config options not yet captured

    ### Package 2: /tmp/context-mode
    - [ ] List every tool, command, and skill
    - [ ] Check hooks/ for Pi-relevant hooks we skipped
    - [ ] Review adapters/ for Pi adapter specifically
    - [ ] Note session event categories we may have missed
    - [ ] Check security/ for any protections not listed

    ### Package 3: /tmp/pi-tool-display
    - [ ] List every source file and its purpose
    - [ ] Check presets.ts for all presets
    - [ ] Review tool-overrides.ts for all tool renderers
    - [ ] Note any display features not in our list

    ### Deliverable
    Report any features found in source packages but MISSING from our checklist.
  reflectEvery: 3
```

## Testing Requirements

| Test Category | Coverage |
|---|---|
| Unit tests | Every extractor (goals, files, commits, preferences, blockers) |
| Hook tests | before-compact, compact, session start, tool call/result |
| Search tests | BM25 ranking, regex mode, stopwords, snippets, expand |
| Scope tests | Lineage filtering, expand restrictions |
| Sandbox tests | Each of 11 language runtimes |
| Security tests | Bash deny, chained commands, shell-escape, path deny |
| Integration tests | Real session fixtures from `~/.pi/agent/sessions` |
| Diff tests | All 3 layouts, all 3 indicators, edge cases |
| Config tests | Toggle on/off, preset application, migration |
| Info-screen tests | Group registration, data provider, reactive updates |

## Open Questions

1. **sqlite-vec integration:** Should we use `@pi-unipi/memory`'s sqlite-vec for vector search, or keep FTS5 only for compactor? FTS5 is sufficient; vector search is memory's domain.
2. **Bun dependency:** Should we require Bun for the sandbox executor's JS/TS speed? Answer: auto-detect, fall back to Node.js.
3. **Language support prioritization:** Which of the 11 languages are MVP? JS/TS, Python, Shell are MVP. Others added incrementally.
4. **Preset name collision:** `opencode` preset in compactor vs pi-tool-display — same name, same intent. Keep.

## Out of Scope

- MCP server/client (handled by `@pi-unipi/mcp`)
- Multi-platform adapters (we're Pi-only)
- `@pi-unipi/utility` modifications per user direction
- Image generation (`@pi-unipi/impeccable`)
- Task/milestone tracking (`@pi-unipi/task`)
- Web tool onboarding (`@pi-unipi/webtools`)
- GUI/external dashboard (everything stays in pi's TUI)

## Success Metrics

| Metric | Target |
|---|---|
| Token reduction | ≥95% on sessions >100 msgs |
| Compaction latency | <100ms for 1K messages |
| Session continuity | 100% survival rate across compactions |
| Search recall | Top-3 hit rate ≥80% for goal/file/commit queries |
| Sandbox output cap | Never exceeds 1MB in context |
| Test coverage | ≥80% line coverage |
| Zero API cost | Compaction requires zero LLM calls |

## Decision Rationale

- **Why fuse all three?** Each solves a different aspect of the same problem (context exhaustion). Separating them forces users to configure three packages. Fusing creates a single, cohesive context experience.
- **Why skip MCP server?** `@pi-unipi/mcp` already exists. Duplicating MCP infrastructure creates maintenance debt.
- **Why skip multi-platform adapters?** We're building for Pi, not Claude Code/Cursor/etc. The adapter pattern is valuable but out of scope.
- **Why toggle + cycle values?** Pure booleans are too coarse. Users want "brief" goals, not just on/off. Cycle values provide presets within each strategy.
- **Why info-screen integration?** Stats visibility is critical for user trust. Showing "42.3K tokens saved, 98.2% reduction" confirms the value proposition.
- **Why Ralph audit requirement?** Source packages are large and feature-rich. A systematic audit loop prevents feature loss during the fusion process.