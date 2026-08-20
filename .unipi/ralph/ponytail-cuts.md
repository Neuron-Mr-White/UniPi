# Ponytail Audit Cuts — Remove Over-Engineering

Repo: /home/oi/Projects/Personal/archived/unipi
Goal: Remove ~8,200 lines + 4 dead deps (shiki, diff, lodash, mime-types) identified in the ponytail-audit, with ZERO behavior change.

## Rules
- Work in batches grouped by package/area
- After EACH batch: run `npx tsc --noEmit --skipLibCheck` — must pass before moving on
- After each phase: run `npm test --workspaces --if-present` for touched packages
- Commit after each successful typecheck with message `refactor(<area>): remove dead/over-engineered code (ponytail-audit)`
- Do NOT change behavior. If a delete looks risky, verify callers with rg first.
- Flag any architectural decisions (e.g. memory dual-backend) — don't auto-decide those.

## Phase 1 — Pure dead code deletes (safest, do first)

### compactor (biggest)
- [x] Delete display/ dead files: diff-renderer.ts(281), tool-overrides.ts(136), render-utils.ts(52), line-width-safety.ts(28). KEEP only clampDiffToWidth in diff-width-safety.ts and sanitizeThinkingArtifacts in thinking-label.ts. Delete their test files.
- [x] Delete runtimeStats instrumentation (index.ts:27,81-87,527-539) + dead debug logger + debug config key + TUI toggle
- [x] Delete transcriptEntries pipeline (brief.ts:208-331 sectionsToTranscript/parseToolLine/extractRef) + fileOps dead ends (hooks.ts:152, types.ts:35,64-70)
- [x] Delete toolDisplay config subtree + dead types (types.ts:186-236, schema.ts:55-58): OutputMode/DiffLayout/DiffIndicator/showTruncationHints/fts5Index/pipeline.ttlCache/proximityReranking/timelineSort/progressiveThrottling/mmapPragma
- [x] Delete deprecated alias scaffolding: 6 tools re-registered (register.ts:115,199-308) + 2 commands (commands/index.ts:50-80) + deprecationLog + 8 const param aliases
- [x] Delete scattered dead: compileBrief, loadProjectPermissions(imported never called), splitChainedCommands, incrementSearchQueries+search_queries column, message_update/end handlers, ctx-execute-file FILE_CONTENT preamble, compactTool(inline it), invalidateSearchCache

### web-api
- [x] Delete lodash dep + getLodash; delete mime-types dep + getMimeTypes (both zero call sites)
- [x] Delete llm-summarize stub provider (71 lines, returns placeholder) + DEFAULT_SUMMARY_PROMPT + createLLMSummarizeResult
- [x] Delete progress subsystem: FetchProgress/FetchExecutionHooks/FetchProgressStatus/FetchOptions hooks/updateProgress + all hooks calls (~90 lines)
- [x] Delete validateApiKey (interface method + 6 impls, never invoked) + config:Record field + dead registry methods (unregister/getBestProvider/getEnabledProviders/count/getProviderByRank)
- [x] Delete formatErrorResult, buildErrorText, validateApiKeyFormat, getCacheSettings/updateCacheSettings/CacheSettings/cache config, getWigoloLastError, checkWigoloHealth

### utility (biggest single win)
- [x] Delete entire diff/ subsystem (~1800 lines): renderer.ts, parser.ts, highlighter.ts, theme.ts, settings.ts, wrapper.ts. Replace registerEnhancedWriteTool/registerEnhancedEditTool by NOT re-registering pi's tools (pi renders its own diffs). Remove shiki dep + diff dep from package.json + @types/*.

### footer
- [x] Delete: getIcons, resolveColor, separatorVisibleWidth, TpsTracker.isGenerating, FooterConfig, PresetDef.segmentOptions/zoneOrder, rainbowText/rainbowBorder, NERD_PRESET(=FULL_PRESET), invalidateGroup, resetFooterRegistry, globalThis assignment, FooterSegment.icon/FooterGroup.icon fields

### info-screen
- [x] Delete: empty INFO_GROUP_REGISTERED listener, recordModuleStart, getLoadTimes, isGroupEnabled, clearSettingsCache, getGlobalRegistry, 5 dead registry methods (unregisterGroup/getGroups/isFetching/per-group subscribe/invalidateAllCaches), sync parseUsageStats + if(!yielder) branch, never-read UsageStats fields, getDialogHeight

### notify
- [x] Delete: moduleHandler (empty body), ntfy section of NotifyConfig + validateConfig checks (dispatch uses ntfy.json), getDialogHeight

### memory
- [x] Delete: InMemoryStorage(90 lines), isMempalaceAvailable, getDb/getScopeDir/isHealthy/hasByTitle, dead mempalace exports, dead embedding exports, stale "search.ts" in files

### mcp
- [x] Delete: auth subsystem (loadAuth/saveAuth/mergeEnvWithAuth/McpAuth), syncIfNeeded/shouldSync auto-sync, createServerTemplate, unused loadCatalog import, McpClient.isConnected/stderr/cwd option

### image
- [x] Delete: registeredProviderIds(), splitModelRef re-export

### ralph
- [x] Delete: phantom 9 commands in MODULE_READY (only ralph+ralph-stop registered), unused banner param of completeLoop, DEFAULT_TEMPLATE, duplicate task file write in startLoop

### subagents
- [x] Delete: FileLock (file-lock.ts + release plumbing), getDefaultMaxTurns/setDefaultMaxTurns/getGraceTurns/setGraceTurns, getAgentConversation, AgentManager.setMaxConcurrent/waitForAll/hasRunning/clearCompleted, inheritContext dead flag, resolveDefaultModel identity wrapper

### cocoindex
- [x] Delete: DEFAULT_LANCEDB_PATH, COCOINDEX_STATE_DIR, minScore, CocoindexDeps interface, lexicalSearch/tokenize/countOccurrences/stopword fallback

### btw
- [x] Delete: dead widget tree (transcript/modeText/summaryText/statusText/hintsText), getTranscriptEntries(), dispatchBtwCommand Promise<boolean> return (all ignore), sessionRuntime in getBtwHandoffThread return, pointless alias const assistantMessage

### updater
- [x] Delete: renderSimple+wordWrap+formatInline (no-theme markdown fallback), validateConfig(0 callers), empty session_shutdown handler, installUpdate optional pi param + UPDATE_APPLIED/UPDATE_ERROR dead events

### kanboard
- [x] Delete: detectDocType+PATH_PATTERNS, placeholder POST /api/docs route, checkExistingInstance (computed then discarded)

### input-shortcuts
- [x] Delete: setRegister(test-only), UndoRedoBuffer.hasUndo/hasRedo(test-only)+lastUndoAt, duplicate THINKING_CYCLE in index.ts:257, SettingsOverlay baseDir/onSaved unused params

### milestone
- [x] Delete: writeMilestones (test-only)

### workflow
- [x] Delete: getWorkflowCommandNames (never imported)

### core
- [x] Delete: dead event constants (MODULE_GONE, MODULE_STATUS_REQUEST/RESPONSE, MEMORY_SEARCHED, UTILITY_CLEANUP_START/CACHE_INVALIDATED/LIFECYCLE_STATE, COCOINDEX_UPDATE_STARTED/COMPLETED/SEARCH_PERFORMED) + payload interfaces + event-contracts test, MEMORY_TYPES

## Phase 2 — Native/stdlib replacements (after P1 verified)
- [x] compactor OS_TMPDIR → os.tmpdir()
- [x] compactor escapeRegex/convertGlobPart → RegExp.escape
- [x] utility removeRecursive → fs.rmSync(recursive,force)
- [ ] footer detectColorMode/rgbTo256 → pi Theme.fg()
- [ ] footer hand-rolled visibleWidth → pi-tui visibleWidth
- [ ] autocomplete fuzzyMatch → pi-tui fuzzyMatch
- [ ] kanboard parseFrontmatter (4 copies) → pi-coding-agent parseFrontmatter
- [x] workflow suggestWorktrees → execFileSync git worktree list
- [x] updater trunc() → pi-tui truncateToWidth
- [ ] ask-user settings-tui ANSI → theme.fg + pi-tui Key
- [ ] web-api duckduckgo HTML parsing → linkedom querySelectorAll
- [ ] web-api dom.ts → defuddle/node entry
- [x] ralph arg tokenizer → core parseArgs

## Phase 3 — Shrink/dedup (after P2 verified)
- [ ] kanboard 8 parsers → one config-driven class
- [ ] updater changelog+readme overlay → one ListDetailOverlay
- [ ] 7 overlays shared ANSI box helpers → one in core
- [ ] 4 settings.json read/write → one shared helper
- [x] compactor formatTokens (4 copies) → one util
- [x] compactor /unipi:compact → 3-line alias wrapper
- [ ] compactor two config merge → one
- [ ] compactor duplicate type declarations → one per type
- [x] subagents dedup helpers (3 files) → import from widget
- [ ] subagents core-compat.ts → declare @pi-unipi/core dep
- [x] footer getGroupForSegment (2 copies) → one
- [x] web-api duplicate fetchOptions → helper
- [x] web-api DEFAULT_SMART_FETCH_SETTINGS vs constants → one
- [x] web-api dependencies.ts lazy-loader → static imports
- [x] ralph completeLoop+stopLoop → one with reason param
- [x] workflow 4 suggest* fns → one suggestFilesFrom
- [ ] ask-user ask-ui renderOptions → one renderer + dispatch
- [ ] milestone snapshot trio → extract to core (shared with workflow)
- [ ] updater version.ts semver → consolidate with cocoindex

## Decision needed (ASK USER — do not auto-cut)
- memory dual-backend: keep mempalace-only OR sqlite-only? (~800 lines removable either way)

## Completion marker
Emit "All ponytail cuts complete. <N> lines removed, <M> deps removed." when all phases done.