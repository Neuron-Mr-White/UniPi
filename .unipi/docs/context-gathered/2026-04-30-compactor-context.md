---
title: "@packages/compactor — Gathered Context"
type: context-gathered
date: 2026-04-30
---

# @packages/compactor — Gathered Context

## Key Findings

### Structure

```
@pi-unipi/compactor/
├── package.json              # pi-package extension, depends on @pi-unipi/core
├── README.md                 # Feature overview
├── skills/                   # 5 skills (routing, doctor, ops, stats, tools)
│   ├── compactor/SKILL.md
│   ├── compactor-doctor/SKILL.md
│   ├── compactor-ops/SKILL.md
│   ├── compactor-stats/SKILL.md
│   └── compactor-tools/SKILL.md
└── src/
    ├── index.ts              # Extension entry point — registers everything
    ├── types.ts              # All TypeScript interfaces
    ├── info-screen.ts        # TUI info screen data provider
    ├── commands/index.ts     # 9 /unipi:compact-* commands
    ├── tools/                # 10 agent tools
    │   ├── register.ts       # Tool registration with TypeBox schemas
    │   ├── compact.ts        # Manual compaction trigger
    │   ├── vcc-recall.ts     # BM25 session history search
    │   ├── ctx-execute.ts    # Sandboxed code execution
    │   ├── ctx-execute-file.ts # File execution with FILE_CONTENT
    │   ├── ctx-batch-execute.ts # Atomic batch of execute+search
    │   ├── ctx-index.ts      # Content → FTS5 index
    │   ├── ctx-search.ts     # FTS5 query
    │   ├── ctx-fetch-and-index.ts # URL → markdown → index
    │   ├── ctx-stats.ts      # Context savings dashboard
    │   └── ctx-doctor.ts     # Diagnostics checklist
    ├── compaction/            # 6-stage zero-LLM pipeline
    │   ├── hooks.ts          # session_before_compact + session_compact integration
    │   ├── summarize.ts      # Main compile() orchestrator
    │   ├── normalize.ts      # Stage 1: Message[] → NormalizedBlock[]
    │   ├── filter-noise.ts   # Stage 2: Remove thinking, noise tools, XML wrappers
    │   ├── build-sections.ts # Stage 3: Goals, files, commits, blockers, preferences
    │   ├── brief.ts          # Stage 4: Brief transcript (truncate, compress, collapse)
    │   ├── format.ts         # Stage 5: Render sections with separators
    │   ├── merge.ts          # Stage 6: Merge with previous summary, dedup
    │   ├── cut.ts            # buildOwnCut — compaction boundary detection
    │   ├── content.ts        # Text utilities
    │   ├── sanitize.ts       # Text sanitization
    │   ├── sections.ts       # SectionData type
    │   ├── recall-scope.ts   # Recall scope utilities
    │   ├── search-entries.ts # BM25-lite search over NormalizedBlock[]
    │   └── extract/          # Section extractors
    │       ├── goals.ts      # Session goal extraction
    │       ├── files.ts      # File activity extraction
    │       ├── commits.ts    # Git commit extraction
    │       └── preferences.ts # User preference extraction
    ├── config/               # Configuration system
    │   ├── manager.ts        # Load/save/scaffold config at ~/.unipi/config/compactor/
    │   ├── schema.ts         # Default config with all strategy defaults
    │   └── presets.ts        # 4 presets: opencode, balanced, verbose, minimal
    ├── session/              # Session continuity layer
    │   ├── db.ts             # SessionDB — SQLite (better-sqlite3/bun:sqlite) per-project
    │   ├── extract.ts        # Event extraction from tool results
    │   ├── resume-inject.ts  # Inject resume snapshot post-compaction
    │   └── snapshot.ts       # XML resume snapshot builder
    ├── display/              # Tool display optimization
    │   ├── tool-overrides.ts # Mode-aware rendering for read/grep/find/ls/bash
    │   ├── thinking-label.ts # Thinking block label formatting + sanitization
    │   ├── user-message-box.ts # Bordered user message display
    │   ├── diff-presentation.ts
    │   ├── diff-renderer.ts
    │   ├── line-width-safety.ts
    │   ├── pending-diff-preview.ts
    │   ├── bash-display.ts
    │   └── render-utils.ts
    ├── executor/             # Sandboxed code execution
    │   ├── executor.ts       # PolyglotExecutor — 11 languages, process isolation
    │   └── runtime.ts        # Runtime detection (bun/node/python/etc.)
    ├── store/                # FTS5 content store
    │   ├── index.ts          # ContentStore — BM25 + trigram + fuzzy + RRF
    │   ├── db-base.ts        # SQLite abstraction with WAL, retry, corruption detection
    │   └── chunking.ts       # Auto-chunking: markdown (by headings), JSON (recursive), plain
    ├── security/             # Security layer
    │   ├── policy.ts         # Pattern parsing, glob-to-regex
    │   ├── scanner.ts        # Shell-escape detection in code
    │   └── evaluator.ts      # Command + file path evaluation against policies
    └── tui/
        └── settings-overlay.ts # Interactive TUI settings editor
```

### Architecture

The compactor is a **Pi extension** (`pi.extensions: ["src/index.ts"]`) that registers via `export default function compactorExtension(pi: ExtensionAPI)`. It has 5 major subsystems:

#### 1. Compaction Core (Zero-LLM)
- **6-stage pipeline**: normalize → filter → build-sections → brief → format → merge
- **Entry point**: `compile()` in `summarize.ts`
- **Trigger**: `session_before_compact` event from Pi
- **Boundary detection**: `buildOwnCut()` in `cut.ts` — finds where to cut messages, respecting prior compactions
- **Output**: Structured summary with sections: Session Goal, Files & Changes, Commits, Outstanding Context, User Preferences, + brief transcript
- **Token reduction**: Claims 95%+ with zero API cost
- **Merging**: Previous summaries are merged with fresh ones, deduplicating sections

#### 2. Session Engine (SQLite + XML)
- **SessionDB**: Per-project SQLite database at `~/.unipi/db/compactor/session.db`
  - Tables: `session_events`, `session_meta`, `session_resume`
  - Max 1000 events per session, dedup window of 5, priority-based eviction
  - Worktree-aware session IDs (SHA256 suffix for non-main worktrees)
- **Event extraction**: `extractEventsFromToolResult()` captures file ops, bash commands, git operations, errors
- **Resume snapshots**: XML format with sections for files, errors, decisions, rules, git, tasks, environment, subagents, skills, intent
  - Includes `<how_to_search>` instructions telling the agent to use `ctx_search` for full details
  - Injected via `injectResumeSnapshot()` during `before_agent_start`

#### 3. FTS5 Content Store
- **ContentStore**: SQLite FTS5 virtual table with porter stemming + unicode61 tokenizer
- **Search layers**: Porter stemmer → Trigram similarity → Fuzzy correction → Reciprocal Rank Fusion (RRF)
- **Chunking**: Auto-chunk by content type (markdown by headings, JSON recursive, plain by paragraphs)
- **Staleness detection**: SHA256 + mtime for file-backed sources
- **DB path**: `~/.unipi/db/compactor/content.db`

#### 4. Sandbox Executor
- **PolyglotExecutor**: 11 languages (JS, TS, Python, Shell, Ruby, Go, Rust, PHP, Perl, R, Elixir)
- **Security**: Strips dangerous env vars (AWS_*, GITHUB_TOKEN, etc.), sanitizes *SECRET*, *PASSWORD*, *TOKEN*, *PRIVATE_KEY*
- **Isolation**: Temp directory per execution, process tree killing, 100MB output cap
- **Runtime detection**: Prefers Bun for JS/TS, falls back to Node/npx tsx
- **Rust**: Special compile-then-run flow

#### 5. Display Engine
- **Mode-aware rendering**: 4 output modes per tool: `hidden`, `summary`, `preview`, `full` (default)
- **Applies to**: read, grep, find, ls, bash tools
- **Intercepts**: `tool_result` event handler transforms output before it enters LLM context
- **Extras**: Thinking label sanitization, user message box borders, diff presentation

### Commands (9 total)

| Command | What It Does | Implementation |
|---------|-------------|----------------|
| `/unipi:compact` | Manual compaction trigger | Calls `compactTool()`, shows stats |
| `/unipi:compact-recall <query>` | BM25 session history search | Calls `vccRecall()` on cached blocks |
| `/unipi:compact-stats` | Context savings dashboard | Calls `ctxStats()` with sessionDB + contentStore |
| `/unipi:compact-doctor` | Diagnostics checklist | Calls `ctxDoctor()` — config, DB, FTS5, runtimes |
| `/unipi:compact-settings` | TUI settings overlay | Opens `CompactorSettingsOverlay` via `ctx.ui.custom()` |
| `/unipi:compact-preset <name>` | Apply preset | `applyPreset()` → `saveConfig()` |
| `/unipi:compact-index` | Index project files into FTS5 | Walks cwd (depth 3, max 100 files), indexes .md/.txt/.ts/.js/.json/.py/.sh |
| `/unipi:compact-search <query>` | Search indexed content | Calls `ctxSearch()` |
| `/unipi:compact-purge` | Wipe all indexed content | Calls `contentStore.purge()` |

### Agent Tools (10 total)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `compact` | (none) | Trigger manual compaction |
| `vcc_recall` | query, mode?, limit?, offset?, expand? | BM25 or regex session history search |
| `ctx_execute` | language, code, timeout? | Run code in sandbox (11 languages) |
| `ctx_execute_file` | language, path, timeout? | Execute file with FILE_CONTENT variable |
| `ctx_batch_execute` | items[] (execute or search) | Atomic batch of commands + searches |
| `ctx_index` | label, content?, filePath?, contentType?, chunkSize? | Chunk content → FTS5 index |
| `ctx_search` | query, limit?, offset? | Query indexed content |
| `ctx_fetch_and_index` | url, label?, chunkSize? | Fetch URL → markdown → index |
| `ctx_stats` | (none) | Context savings dashboard |
| `ctx_doctor` | (none) | Diagnostics checklist |

### When It Is Triggered

The compactor hooks into **8 Pi events**:

| Event | When | What Compactor Does |
|-------|------|-------------------|
| `session_start` | Session begins | Initializes SessionDB, ContentStore, Executor; registers tools + commands; emits MODULE_READY |
| `before_agent_start` | Before each agent turn | Reloads config, re-caches normalized blocks, injects resume snapshot |
| `session_before_compact` | Before Pi's compaction | Runs 6-stage pipeline (if compactor-triggered or override enabled), returns summary + stats |
| `session_compact` | After compaction completes | Increments compact count, shows notification |
| `session_shutdown` | Session ends | Cleans up old sessions (>7 days), kills background processes, closes DBs |
| `input` | Before tool execution | Blocks dangerous bash commands (curl/wget/nc/netcat) |
| `tool_result` | After tool execution | Extracts session events (file ops, bash, git, errors); applies display overrides |
| `message_update` | During message streaming | Logs thinking block lengths (debug only) |
| `message_end` | After message completes | Debug logging |
| `context` | Context window update | Sanitizes thinking artifacts from context |

**Compaction triggers:**
- **Automatic**: When Pi fires `session_before_compact` (context window full)
- **Manual**: `/unipi:compact` command or `compact` tool
- **Override**: If `config.overrideDefaultCompaction === true`, compactor takes over Pi's default compaction

### What Is Configurable

Config lives at `~/.unipi/config/compactor/config.json`. Each strategy has `enabled` (boolean) + `mode` (enum):

| Strategy | Modes | Default | What It Controls |
|----------|-------|---------|-----------------|
| `sessionGoals` | full, brief, off | full | Goal extraction from conversation |
| `filesAndChanges` | all, modified-only, off | all | File activity tracking (maxPerCategory: 10) |
| `commits` | full, brief, off | full | Git commit extraction (maxCommits: 8) |
| `outstandingContext` | full, critical-only, off | full | Blocker/pending item tracking (maxItems: 5) |
| `userPreferences` | all, recent-only, off | all | Preference tracking (maxPreferences: 10) |
| `briefTranscript` | full, compact, minimal, off | full | Rolling message window (userTokenLimit: 256, assistantTokenLimit: 200, toolCallLimit: 8) |
| `sessionContinuity` | full, essential-only, off | full | XML resume snapshots (eventCategories: []) |
| `fts5Index` | auto, manual, off | manual | FTS5 indexing (chunkSize: 4096, cacheTtlHours: 24) |
| `sandboxExecution` | all, safe-only, off | all | Code execution (allowedLanguages: js/ts/py/sh, outputLimit: 100MB) |
| `toolDisplay` | opencode, balanced, verbose, custom | opencode | Tool output rendering (diffLayout, diffIndicator, showThinkingLabels, etc.) |

**Global settings:**
- `overrideDefaultCompaction: false` — Take over Pi's built-in compaction
- `debug: false` — Enable verbose logging
- `showTruncationHints: true` — Show truncation indicators

**4 Presets:**
- **opencode**: Maximal context preservation, minimal display
- **balanced**: Moderate across all strategies, auto FTS5
- **verbose**: Everything visible, everything tracked
- **minimal**: Only compaction + basic recall, most features disabled

### Patterns

- **Extension pattern**: Single `export default function(pi: ExtensionAPI)` entry point
- **Event-driven**: All behavior triggered by Pi lifecycle events
- **Dependency injection**: Commands and tools receive deps (sessionDB, contentStore, sessionId) via closures
- **Lazy initialization**: Services initialized in `session_start`, commands re-registered with fresh deps
- **Graceful degradation**: Non-fatal catches everywhere, works without FTS5/executor
- **SQLite abstraction**: Dynamic import of bun:sqlite or better-sqlite3, with WAL + retry
- **TypeBox schemas**: All tool parameters use @sinclair/typebox for LLM discoverability
- **Debug logging**: Conditional on `config.debug`, uses `[compactor:HH:MM:SS.mmm]` prefix

### Gaps / Open Items

1. **Auto-indexing TODO**: In `index.ts` there's `// TODO: index project files` when fts5Index.mode === "auto"
2. **Stats incomplete**: `ctxStats` returns `tokensSaved: 0` and `sandboxRuns: 0` — not tracked persistently
3. **No cross-session recall**: `vccRecall` only searches current session's cached blocks, not historical sessions
4. **ContentStore search re-init**: `ctxSearch` and `ctxIndex` create new ContentStore instances each call (not reusing the session-level one)
5. **No test files**: No test directory found in the package
6. **Display overrides limited**: Only read/grep/find/ls/bash get overrides; edit/write don't despite being listed in ToolDisplayConfig.registerToolOverrides

### Recommendations

- The compactor is a mature, well-structured extension with clear separation of concerns
- The 6-stage pipeline is the core value proposition — zero-LLM compaction with structured output
- Session continuity via XML snapshots is a clever approach to surviving compaction boundaries
- The FTS5 store with multi-layer search (porter + trigram + fuzzy + RRF) is sophisticated
- Configuration is thorough with good presets — the TUI overlay is a nice touch
- Security layer exists but appears underutilized (scanner not called from executor, evaluator not wired into tool_result)
