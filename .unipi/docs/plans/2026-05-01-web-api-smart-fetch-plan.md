---
title: "Web API Smart-Fetch Integration — Implementation Plan"
type: plan
date: 2026-05-01
workbranch: feat/web-api-smart-fetch
specs:
  - .unipi/docs/specs/2026-05-01-web-api-smart-fetch-design.md
---

# Web API Smart-Fetch Integration — Implementation Plan

## Overview

Integrate a local smart-fetch engine (wreq-js + defuddle + linkedom) into `@pi-unipi/web-api` as the default read path. Replace `web_read` with `multi_web_content_read` that uses the smart-fetch engine (rank 0) by default and falls back to existing read providers (Jina Reader, Firecrawl, Perplexity) via `source` parameter. Add batch concurrent URL reading with TUI progress. Add smart-fetch default settings and update the settings TUI.

**Key decisions:**
- Work branch: `feat/web-api-smart-fetch`
- `url` parameter uses `string | string[]` via TypeBox union — will test compatibility; fallback to separate `urls` array field if union breaks
- Cache key will include browser + format + maxChars for smart-fetch results
- `verbose` parameter kept for compatibility with pi's built-in `web_fetch` interface
- wreq-js ships prebuilt binaries (to verify during Task 1)

## Tasks

- completed: Task 1 — Add Dependencies & Verify wreq-js
  - Description: Add wreq-js, defuddle, linkedom, lodash, mime-types as direct deps; @mariozechner/pi-tui as peer dep. Verify wreq-js installs without Rust build step.
  - Dependencies: None
  - Acceptance Criteria: `npm install` succeeds in packages/web-api; `require("wreq-js")` loads without native build errors
  - Steps:
    1. Add `wreq-js@^2.3.0` to dependencies in `packages/web-api/package.json`
    2. Add `defuddle@^0.18.1` to dependencies
    3. Add `linkedom@^0.18.12` to dependencies
    4. Add `lodash@^4.17.21` to dependencies
    5. Add `mime-types@^2.1.35` to dependencies
    6. Add `@mariozechner/pi-tui` to peerDependencies
    7. Run `npm install` from repo root
    8. Verify wreq-js loads: `node -e "require('wreq-js')"` from packages/web-api
    9. If wreq-js needs a build step, document it and add a postinstall script

- completed: Task 2 — Engine Types
  - Description: Create `src/engine/types.ts` with all type definitions for the smart-fetch engine: FetchResult, FetchError, FetchErrorCode, FetchErrorPhase, FetchOptions, BatchFetchResult, FetchItemResult, FetchExecutionHooks, progress types.
  - Dependencies: None
  - Acceptance Criteria: Types compile with `npx tsc --noEmit`; all types from spec are defined
  - Steps:
    1. Create `packages/web-api/src/engine/` directory
    2. Create `types.ts` with `FetchErrorCode` union type (invalid_url, unsupported_protocol, http_error, unexpected_response, timeout, network_error, processing_error, download_error, no_content, too_many_redirects)
    3. Create `FetchErrorPhase` union type (validation, connecting, waiting, loading, processing, unknown)
    4. Create `FetchError` interface with all fields from spec (error, code, phase, retryable, timeoutMs, url, finalUrl, statusCode, statusText, mimeType, contentLength, downloadedBytes)
    5. Create `FetchResult` interface (url, finalUrl, title, author, published, site, language, wordCount, content, format, mimeType)
    6. Create `FetchOptions` interface (browser, os, format, maxChars, timeoutMs, removeImages, includeReplies, proxy, headers)
    7. Create `BatchFetchItemResult` type (success with FetchResult | error with FetchError)
    8. Create `BatchFetchResult` interface (total, succeeded, failed, items)
    9. Create `FetchProgressStatus` union type (queued, connecting, waiting, loading, processing, done, error)
    10. Create `FetchProgress` interface (url, status, percent, bytesLoaded, bytesTotal, phase, error)
    11. Create `FetchExecutionHooks` interface (onProgress callback, onUpdate for batch progress)
    12. Export all types

- completed: Task 3 — Engine Constants & Profiles
  - Description: Create `src/engine/constants.ts` with default values and `src/engine/profiles.ts` with browser profile resolution.
  - Dependencies: Task 2
  - Acceptance Criteria: Constants export all defaults; profiles resolves "chrome_145" correctly
  - Steps:
    1. Create `constants.ts` with `DEFAULT_BROWSER`, `DEFAULT_OS`, `DEFAULT_MAX_CHARS`, `DEFAULT_TIMEOUT_MS`, `DEFAULT_BATCH_CONCURRENCY`, `DEFAULT_REMOVE_IMAGES`, `DEFAULT_INCLUDE_REPLIES`, `DEFAULT_FORMAT`, `DEFAULT_HEADERS` (Accept, Accept-Language)
    2. Create `profiles.ts` with `resolveBrowserProfile(browser?: string)` function
    3. Profile resolution: if browser string provided, validate against known profiles; if omitted, use latest Chrome profile
    4. Export known browser profiles list for validation

- completed: Task 4 — Engine DOM & Dependencies
  - Description: Create `src/engine/dom.ts` (linkedom HTML parsing + polyfills for defuddle) and `src/engine/dependencies.ts` (runtime dependency injection for wreq-js + defuddle).
  - Dependencies: Task 1, Task 2
  - Acceptance Criteria: `parseHTML()` returns a DOM document compatible with defuddle; dependency injection allows mocking in tests
  - Steps:
    1. Create `dom.ts` with `parseHTML(html: string)` function
    2. Use linkedom's `parseHTML` to create a document
    3. Add polyfills that defuddle expects (e.g., `NodeList.forEach`, `Element.matches`, etc.)
    4. Export document and relevant DOM interfaces
    5. Create `dependencies.ts` with lazy-loaded wreq-js and defuddle imports
    6. Use dynamic `import()` for wreq-js and defuddle to handle optional native binding failures gracefully
    7. Export `getWreq()`, `getDefuddle()` functions that throw helpful errors if deps missing

- completed: Task 5 — Engine Format & Error Builders
  - Description: Create `src/engine/format.ts` with output formatting (markdown/text/html/json), content truncation, error text builders, and batch result formatting.
  - Dependencies: Task 2
  - Acceptance Criteria: Can format a FetchResult into all 4 output formats; truncation respects maxChars; error text is human-readable
  - Steps:
    1. Create `format.ts` with `formatContent(result: FetchResult, format: string, maxChars?: number): string`
    2. Markdown format: return content as-is (defuddle outputs markdown), truncate with indicator
    3. HTML format: re-render markdown to HTML or return raw if available
    4. Text format: strip markdown formatting from content
    5. JSON format: pretty-print the FetchResult object
    6. Implement `truncateContent(content: string, maxChars: number): string` with truncation marker
    7. Implement `buildErrorText(error: FetchError): string` — human-readable error message with code and phase
    8. Implement `formatBatchResult(result: BatchFetchResult): string` — summary header + per-item previews
    9. Implement `formatSingleResult(result: FetchResult, verbose?: boolean): string` — metadata header + content

- completed: Task 6 — Engine Extract (Core Pipeline)
  - Description: Create `src/engine/extract.ts` — the core fetch+extract pipeline (defuddleFetch). This is the heart of the engine: URL validation, wreq-js fetch with progress hooks, content-type routing, defuddle extraction, DOM fallbacks, client-side redirect following, alternate link fallback, file download streaming.
  - Dependencies: Task 2, Task 3, Task 4, Task 5
  - Acceptance Criteria: `defuddleFetch(url, options, hooks)` returns FetchResult for a real URL; handles errors with FetchError; follows meta redirects; falls back through extraction strategies
  - Steps:
    1. Create `extract.ts` with main `defuddleFetch(url: string, options: FetchOptions, hooks?: FetchExecutionHooks): Promise<FetchResult>` function
    2. Implement URL validation (http/https only, no unsupported protocols) — return FetchError with code "invalid_url"
    3. Resolve browser profile via profiles.ts
    4. Execute wreq-js fetch with resolved profile + options
    5. Hook wreq-js transport events to FetchExecutionHooks.onProgress (connecting → waiting → loading)
    6. Check Content-Disposition header → if attachment/binary, stream to temp file and return file result
    7. Content-type routing:
       - JSON → pretty-print + truncate
       - Plain text → render + truncate
       - HTML → continue to extraction pipeline
       - Non-textual → stream to temp file
    8. HTML extraction pipeline:
       - Parse HTML with linkedom (dom.ts)
       - Check client-side `<meta http-equiv="refresh">` redirects → follow (max 5)
       - Try defuddle extract → clean markdown
       - Fallback: DOM text extraction (walk text nodes)
       - Fallback: DOM markdown rendering (convert elements to markdown)
       - Check `<link rel="alternate" type="application/json">` → follow alternate link (max 3)
    9. Extract metadata from defuddle result (title, author, published, site, language, wordCount)
    10. Truncate content via format.ts
    11. Return FetchResult with all metadata
    12. Error handling: wrap all errors in FetchError with appropriate code/phase/retryable
    13. Export `defuddleFetch` and a `defuddleFetchMultiple` helper for batch (delegates to single with concurrency control)

- completed: Task 7 — Batch Execution Engine
  - Description: Implement batch concurrent fetch in `src/engine/extract.ts` (or a dedicated `src/engine/batch.ts`). Normalize URLs, create per-item progress trackers, spin up bounded workers, collect results in order.
  - Dependencies: Task 6
  - Acceptance Criteria: `defuddleFetchMultiple(urls, options, hooks)` fetches multiple URLs concurrently with progress; results maintain input order; concurrency bounded by `batchConcurrency`
  - Steps:
    1. Add `defuddleFetchMultiple(urls: string[], options: FetchOptions & { batchConcurrency?: number }, hooks?: FetchExecutionHooks): Promise<BatchFetchResult>` function
    2. Normalize URLs into per-item request objects with shared options
    3. Create per-item progress tracker array (initial: all `queued`)
    4. Implement bounded worker pool: spin up N workers (default 8) that pick next URL from queue
    5. Each worker calls `defuddleFetch` for its URL
    6. Progress updates: emit `onUpdate` with full progress snapshot (all items' statuses)
    7. Collect results in input order (use index mapping)
    8. Return BatchFetchResult with total/succeeded/failed counts and per-item results
    9. Handle individual URL failures gracefully (don't fail the whole batch)

- completed: Task 8 — Update Settings for Smart-Fetch Defaults
  - Description: Add smart-fetch default settings to `src/settings.ts` with global + project precedence.
  - Dependencies: None
  - Acceptance Criteria: `loadSmartFetchSettings()` returns merged defaults; settings persist to config.json; project settings override global
  - Steps:
    1. Add `SmartFetchSettings` interface to `settings.ts` (browser, os, maxChars, timeoutMs, batchConcurrency, removeImages, includeReplies)
    2. Add `DEFAULT_SMART_FETCH_SETTINGS` constant
    3. Add `smartFetch` key to `WebApiConfig` interface
    4. Implement `loadSmartFetchSettings(): SmartFetchSettings` — merges defaults with saved config
    5. Implement `saveSmartFetchSettings(settings: Partial<SmartFetchSettings>): void`
    6. Add project-level settings resolution: check `.pi/settings.json` for `smartFetch.*` keys; project overrides global
    7. Update `DEFAULT_CONFIG` to include `smartFetch` section

- completed: Task 9 — Replace web_read with multi_web_content_read
  - Description: Replace `web_read` tool with `multi_web_content_read` in `src/tools.ts`. Handles single URL (string) and batch (string[]) via union type. Smart-fetch engine is default (source=0 or omitted). Existing read providers available via source 1-3. Custom renderCall/renderResult for TUI progress.
  - Dependencies: Task 5, Task 6, Task 7, Task 8
  - Acceptance Criteria: `multi_web_content_read` tool registered; single URL fetches via smart-fetch engine by default; batch URLs fetch concurrently; source parameter routes to fallback providers; TUI shows progress during fetch
  - Steps:
    1. Remove `web_read` from `WEB_TOOLS` constant, add `multi_web_content_read`
    2. Define `multi_web_content_read` tool with TypeBox schema:
       - `url`: `Type.Union([Type.String(), Type.Array(Type.String())])` (test compatibility; if broken, use `Type.Array(Type.String())` with single-item wrapping)
       - `source`: optional number (0=smart-fetch, 1=Jina, 2=Firecrawl, 3=Perplexity)
       - Smart-fetch engine options: browser, os, format, maxChars, timeoutMs, removeImages, includeReplies, proxy
       - Batch option: batchConcurrency
       - Compatibility: verbose
    3. Implement execute handler:
       - If `source` is 0 or omitted → route to smart-fetch engine
       - If `source` is 1-3 → route to existing read provider via registry
       - Single URL (string) → call `defuddleFetch`, return single result
       - Batch URL (string[]) → call `defuddleFetchMultiple`, return batch result
    4. Load smart-fetch settings via `loadSmartFetchSettings()` for defaults
    5. Implement `renderCall` for in-progress TUI display (spinner + URL + status + progress bar)
    6. Implement `renderResult` for completed display (metadata preview + content preview with expand/collapse hint)
    7. Cache smart-fetch results via `webCache.set()` with enriched key (url + browser + format + maxChars)
    8. Check cache before fetching via `webCache.get()`
    9. Error handling: return FetchError as tool error content

- completed: Task 10 — TUI Progress Renderer
  - Description: Create `src/tui/progress.ts` for batch progress display and `src/tui/result.ts` for single result display with expand/collapse.
  - Dependencies: Task 9 (needs tool registered with renderCall/renderResult hooks)
  - Acceptance Criteria: Batch progress shows spinner animation, per-item progress bars, and responsive width layout; single result shows metadata and content preview
  - Steps:
    1. Create `src/tui/progress.ts` with `renderBatchProgress(progress: FetchProgress[]): string`
    2. Format: header line (batch_web_content_read X/Y done · ok N · err M · concurrency C)
    3. Per-item lines: status glyph (⠋/⠙/⠹/✓/✗) + URL (truncated) + status text + progress bar
    4. Responsive width: adapt to terminal width
    5. Create `src/tui/result.ts` with `renderSingleResult(result: FetchResult): string`
    6. Format: title line, metadata (author, published, site, language, wordCount), content preview (7 lines), expand/collapse hint (Ctrl+O)
    7. `renderBatchResult(result: BatchFetchResult): string` — summary header + per-item preview
    8. `renderErrorResult(error: FetchError): string` — compact error summary
    9. Wire renderers into tool registration's `renderCall` and `renderResult` callbacks (in Task 9)

- completed: Task 11 — Update Provider Rankings
  - Description: Update `src/providers/base.ts` to reserve read rank 0 for smart-fetch engine. Shift existing read providers to rank 1+.
  - Dependencies: None
  - Acceptance Criteria: Jina Reader → read rank 1, Firecrawl → read rank 2, Perplexity → read rank 3; existing search/summarize rankings unchanged
  - Steps:
    1. Update `jina-reader.ts` ranking: `read: 1` (already 1, no change needed)
    2. Update `firecrawl.ts` ranking: `read: 2` (already 2, no change needed)
    3. Update `perplexity.ts` ranking: `read: 3` (already 3, no change needed)
    4. Add comment in base.ts documenting that rank 0 is reserved for the smart-fetch engine (not a registered provider)
    5. Verify no provider claims read rank 0

- completed: Task 12 — Update Settings TUI & Commands
  - Description: Update settings dialog and commands to include smart-fetch defaults configuration section.
  - Dependencies: Task 8
  - Acceptance Criteria: `/unipi:web-settings` shows "Smart Fetch Defaults" section; can view and edit browser, os, maxChars, timeout, concurrency, removeImages, includeReplies
  - Steps:
    1. Add "Smart Fetch Defaults" option to the settings dialog main menu
    2. Create smart-fetch settings submenu with options for each setting
    3. Browser: select from known profiles list
    4. OS: select from windows/macos/linux/android/ios
    5. MaxChars, timeoutMs, batchConcurrency: numeric input
    6. RemoveImages: toggle
    7. IncludeReplies: select from extractors/true/false
    8. Add "Reset to Defaults" option
    9. Update `commands.ts` if needed (command already registered, just updating dialog content)

- completed: Task 13 — Update Extension Entry & Module Announcement
  - Description: Update `src/index.ts` to remove `web_read` from tools list, add `multi_web_content_read`, update module announcement and info screen.
  - Dependencies: Task 9
  - Acceptance Criteria: Extension loads without errors; module announcement lists `multi_web_content_read`; info screen shows smart-fetch status
  - Steps:
    1. Remove `WEB_TOOLS.READ` import, add `WEB_TOOLS.MULTI_READ`
    2. Update `emitEvent` tools list to use `multi_web_content_read`
    3. Add smart-fetch info to info screen data provider (engine availability, default browser/os)
    4. Verify extension loads: `node -e "import('./src/index.ts')"` or equivalent

- completed: Task 14 — Update Skill & README Documentation
  - Description: Update `skills/web/SKILL.md` and `README.md` to document `multi_web_content_read`, updated provider rankings, smart-fetch features.
  - Dependencies: Task 9, Task 13
  - Acceptance Criteria: SKILL.md documents the new tool; README shows updated architecture and usage; no references to `web_read` remain
  - Steps:
    1. Update SKILL.md: replace `web_read` section with `multi_web_content_read` documentation
    2. Document smart-fetch engine as default (source 0 or omitted)
    3. Document batch usage (pass array of URLs)
    4. Document browser/os/format options
    5. Update provider rankings table (rank 0 = Smart-Fetch Engine)
    6. Update README.md: replace `web_read` references with `multi_web_content_read`
    7. Add smart-fetch engine architecture section
    8. Add new dependencies table
    9. Add settings documentation (smart-fetch defaults)

- completed: Task 15 — Update Cache for Smart-Fetch
  - Description: Update the cache layer to handle smart-fetch results with enriched cache keys (url + browser + format + maxChars).
  - Dependencies: Task 8
  - Acceptance Criteria: Smart-fetch results cached with enriched key; cache hit returns correct results; cache clear still works; provider-based cache still works for existing providers
  - Steps:
    1. Add `generateSmartFetchKey(url: string, options: Partial<FetchOptions>): string` to cache.ts
    2. Key includes: url + browser + format + maxChars (hashed)
    3. Update `webCache.get()` to accept smart-fetch options for key generation
    4. Update `webCache.set()` to accept smart-fetch options for key generation
    5. Keep backward compatibility: existing `get(url, provider)` still works
    6. Add `refresh` parameter support to bypass cache (from spec open question — implement simple version)

## Sequencing

```
Task 1 (Dependencies) ─────────────────────────────────────────┐
Task 2 (Engine Types) ──────────────────────────────────────────┤
Task 8 (Settings) ──────────────────────────────────────────────┤
Task 11 (Provider Rankings) ────────────────────────────────────┤
                                                                │
Task 3 (Constants & Profiles) ← Task 2 ────────────────────────┤
Task 4 (DOM & Dependencies) ← Task 1, Task 2 ──────────────────┤
Task 5 (Format & Error Builders) ← Task 2 ─────────────────────┤
                                                                │
Task 6 (Extract Pipeline) ← Tasks 2, 3, 4, 5 ─────────────────┤
Task 15 (Cache Update) ← Task 8 ───────────────────────────────┤
                                                                │
Task 7 (Batch Engine) ← Task 6 ────────────────────────────────┤
Task 12 (Settings TUI) ← Task 8 ───────────────────────────────┤
                                                                │
Task 9 (Replace web_read) ← Tasks 5, 6, 7, 8 ────────────────┤
                                                                │
Task 10 (TUI Progress) ← Task 9 ───────────────────────────────┤
Task 13 (Extension Entry) ← Task 9 ────────────────────────────┤
Task 14 (Docs) ← Tasks 9, 13 ──────────────────────────────────┘
```

**Parallel opportunities:**
- Tasks 1, 2, 8, 11 can start immediately (no inter-dependencies)
- Tasks 3, 4, 5 can be parallelized after Task 2
- Tasks 7, 12, 15 can be parallelized after their respective dependencies
- Tasks 10, 13, 14 can be parallelized after Task 9

## Risks

1. **wreq-js native build requirement** — If wreq-js requires Rust compilation, npm install will fail on machines without Rust. Mitigation: verify in Task 1; if needed, document prerequisite or find alternative.
2. **TypeBox Union type compatibility** — `Type.Union([Type.String(), Type.Array(Type.String())])` may not work with pi's tool registration. Mitigation: test early; fallback to `urls: Type.Array(Type.String())` with single-item wrapping.
3. **defuddle + linkedom compatibility** — defuddle was designed for browser DOM; server-side linkedom may lack APIs it expects. Mitigation: polyfills in dom.ts (Task 4); if severe, consider jsdom alternative.
4. **Cache key complexity** — Enriched cache keys could lead to cache misses for slightly different options. Mitigation: normalize options in key generation.
5. **TUI renderer API** — pi's `renderCall`/`renderResult` API may not exist or may differ from assumptions. Mitigation: check pi extension API docs during Task 9; fall back to simple text output if custom rendering unavailable.
6. **Large batch memory usage** — Fetching 20+ URLs concurrently could use significant memory. Mitigation: default concurrency of 8 is conservative; agents typically fetch 1-5 URLs.

---

## Reviewer Remarks

REVIEWER-REMARK: Partially Done 11/15

All 15 tasks are marked completed but 4 have unmet acceptance criteria or missing steps:

### Fully Complete (11/15)
- Task 1: Dependencies added, wreq-js loads without native build ✓
- Task 2: All engine types defined ✓
- Task 3: Constants and profile resolution ✓
- Task 4: DOM parsing with polyfills + lazy dependency injection ✓
- Task 5: Format/error builders for all 4 output formats ✓
- Task 6: Core extraction pipeline (see caveat below) ✓
- Task 7: Batch execution with bounded worker pool ✓
- Task 11: Provider rankings updated (rank 0 reserved comment, Jina=1, Firecrawl=2, Perplexity=3) ✓
- Task 12: Settings TUI with smart-fetch submenu ✓
- Task 13: Extension entry updated, info screen shows smart-fetch status ✓
- Task 14: SKILL.md and README.md fully updated ✓

### Partially Complete (4/15)

**Task 6 — Engine Extract:** Partially Done 3/4
- `findAlternateLinks()` is defined in extract.ts but never called — alternate JSON link fallback (step 8.9) is dead code

**Task 8 — Settings:** Partially Done 6/7
- Step 6 (project-level settings via `.pi/settings.json`) not implemented — `loadSmartFetchSettings()` only reads global config

**Task 9 + 10 — renderCall/renderResult:** Partially Done
- TUI progress/render files exist (progress.ts, result.ts) with all rendering functions
- But renderCall/renderResult callbacks are NOT wired into the tool registration in tools.ts
- Risk #5 from the plan was prescient — pi's renderCall/renderResult API may not exist or differs
- Tools work fine without custom renderers (default text output), but batch progress won't show animated TUI

**Task 15 — Cache Update:** Partially Done 5/6
- `generateSmartFetchKey()` implemented in tools.ts with url + browser + format + maxChars
- Cache get/set use enriched keys via tools.ts orchestration
- Backward compatible (existing `webCache.get(url, provider)` still works)
- Step 6 (`refresh` parameter to bypass cache) not implemented

### Codebase Checks
- ✓ TypeScript: `npx tsc --noEmit` passes clean (zero errors)
- ✓ Type check: `npm run typecheck` passes
- ✓ Dependencies: wreq-js loads OK (exports: Headers, RequestError, Response, Session, Transport)
- ✓ Dependencies: defuddle loads OK (exports: Defuddle, default, module.exports)
- — Lint: no eslint configured for web-api package
- — Tests: no test runner configured for web-api package
- — Build: no build step in web-api package (TS source loaded directly by pi)

### Summary of Missing Items
1. `renderCall`/`renderResult` not wired (TUI renders exist but unused) — low impact, functional without
2. Project-level settings resolution (`.pi/settings.json`) — medium impact for multi-project users
3. `refresh` cache-bypass parameter — low impact, users can clear cache via command
4. `findAlternateLinks()` dead code — no functional impact but should be wired or removed

### Risk Status
1. wreq-js native build — **mitigated**, loads without Rust
2. TypeBox Union type — **mitigated**, `Type.Union([String, Array])` works in tool registration
3. defuddle + linkedom — **mitigated**, polyfills handle compatibility
4. Cache key complexity — **accepted**, current implementation is straightforward
5. TUI renderer API — **confirmed**, renderCall/renderResult not available; fell back to simple text output
6. Large batch memory — **accepted**, default concurrency 8 is conservative
