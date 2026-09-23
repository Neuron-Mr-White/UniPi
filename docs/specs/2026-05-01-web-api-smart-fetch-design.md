---
title: "Web API Smart-Fetch Integration"
type: brainstorm
date: 2026-05-01
---

# Web API Smart-Fetch Integration

## Problem Statement

Our `@pi-unipi/web-api` package provides search, read, and summarize tools through a provider-based architecture. While this works well for search (where diverse API providers add real value), the read path is weak — it relies on third-party APIs (Jina Reader, Firecrawl) to extract content, adding latency, cost, and fragility. The `agent-smart-fetch` project (Thinkscape) demonstrates a superior approach: local browser-grade TLS fingerprinting via `wreq-js` + intelligent content extraction via `defuddle`, producing cleaner results with no API key requirements.

We need to bring this smart-fetch capability into our package as the default read path, while keeping all existing providers as alternatives, and adding batch concurrent reading with TUI progress.

## Context

### Current State
- `@pi-unipi/web-api` provides 3 tools: `web_search`, `web_read`, `web_llm_summarize`
- 8 providers registered in a ranked provider system
- `web_read` routes through provider registry (Jina Reader default, Firecrawl/Perplexity as alternatives)
- Simple error model (string-based), no progress streaming, no batch support, no TUI renderers
- DuckDuckGo provider scrapes HTML with regex (fragile)

### agent-smart-fetch Analysis
- Uses `wreq-js` (Rust-backed TLS fingerprinting) + `defuddle` (content extraction) + `linkedom` (server-side DOM)
- Rich `FetchResult` with title, author, published, site, language, wordCount, finalUrl
- Rich `FetchError` with error codes, phases, retryable flags, timeout hints
- Batch fetch with bounded concurrency, per-item progress snapshots, TUI progress bars
- Content extraction pipeline: Defuddle → DOM text fallback → DOM markdown fallback → alternate link fallback
- File download support: streams attachments/binaries to temp files
- Multiple output formats: markdown, html, text, json
- Client-side meta redirect following, alternate content fallback
- Pi settings integration with global + project-level precedence

### Key Insight
Search benefits from provider diversity (different APIs, different results). Read benefits from extraction quality — one excellent local pipeline beats multiple API-mediated ones. `web_llm_summarize` serves a different purpose entirely (token-saving via external API summarization).

## Chosen Approach

Build the smart-fetch engine directly into `@pi-unipi/web-api` as an internal module. Replace `web_read` with `multi_web_content_read` that uses the smart-fetch engine as default (rank 0) and keeps existing read providers as fallback alternatives via `source` parameter. Add batch concurrent reading with TUI progress when multiple URLs are provided.

## Why This Approach

- **No external dependency on pi-smart-fetch** — we own the code, can customize, and avoid version coupling
- **Unified tool surface** — `multi_web_content_read` handles both single and batch reads; single URL is just a batch of 1
- **Backwards-compatible provider system** — all search and read providers stay, nothing is removed
- **Agent experience** — default path is free, local, and high-quality; specific providers available when needed
- **Clean separation of concerns** — search = provider diversity, read = extraction quality, summarize = token savings

### Alternatives Rejected

1. **Depend on pi-smart-fetch as external package** — adds coupling, version conflicts, can't customize
2. **Add smart-fetch as a provider in registry** — provider interface too simple for browser/os/format/proxy params
3. **Standalone multi_web_fetch tool alongside web_read** — two parallel read paths confuses agents
4. **Remove read providers** — loses API-based fallbacks for edge cases defuddle can't handle

## Design

### Tool Surface

Three tools (same count as before):

| Tool | Engine | Purpose |
|---|---|---|
| `web_search` | Provider registry | Find URLs/information via search APIs |
| `multi_web_content_read` | Smart-fetch engine (default) + read providers (fallback) | Read full content from URLs, single or batch |
| `web_llm_summarize` | Provider registry (Perplexity) | Token-saving URL summarization via API |

`web_read` is removed and replaced by `multi_web_content_read`.

### multi_web_content_read Parameters

```typescript
{
  // URL input: single string or array of strings
  url: string | string[],           // required

  // Source selection (optional)
  source?: number,                   // 0=smart-fetch engine (default),
                                     // 1=Jina Reader, 2=Firecrawl, 3=Perplexity

  // Smart-fetch engine options (used when source=0 or omitted)
  browser?: string,                  // TLS fingerprint profile, default "chrome_145"
  os?: string,                       // OS fingerprint, default "windows"
  format?: "markdown"|"html"|"text"|"json",  // default "markdown"
  maxChars?: number,                 // default 50,000
  timeoutMs?: number,                // default 15,000
  removeImages?: boolean,            // strip image refs, default false
  includeReplies?: boolean|"extractors",  // default "extractors"
  proxy?: string,                    // proxy URL

  // Batch options (array URLs only)
  batchConcurrency?: number,         // default 8

  // Compatibility
  verbose?: boolean                  // metadata header toggle
}
```

### Result Format

**Single URL** (url is string):
```typescript
{
  url: string,
  finalUrl: string,
  title: string,
  author: string,
  published: string,
  site: string,
  language: string,
  wordCount: number,
  content: string       // extracted and formatted content
}
```

**Batch** (url is string[]):
```typescript
{
  total: number,
  succeeded: number,
  failed: number,
  items: Array<{
    url: string,
    status: "done" | "error",
    result?: {           // same shape as single result (when status="done")
      url: string,
      finalUrl: string,
      title: string,
      author: string,
      published: string,
      site: string,
      language: string,
      wordCount: number,
      content: string
    },
    error?: string       // human-readable error (when status="error")
  }>
}
```

### Read Provider Ranking (updated)

| Rank | Provider | Cost | API Key |
|---|---|---|---|
| 0 | Smart-Fetch Engine | Free, local | No |
| 1 | Jina Reader | Freemium | Optional |
| 2 | Firecrawl | Paid | Required |
| 3 | Perplexity | Paid | Required |

Omit `source` (or set `source: 0`) → auto-selects rank 0 (smart-fetch engine). Set `source: 1/2/3` → routes to that specific provider.

**Note on overlap with pi's built-in `web_fetch`**: Pi ships `web_fetch` and `batch_web_fetch` natively via `pi-smart-fetch`. Our `multi_web_content_read` uses the same underlying engine (`wreq-js` + `defuddle`) but adds our provider fallback system (`source` parameter), our cache layer, our settings integration, and our unified single+batch interface. Agents should prefer `multi_web_content_read` when they want provider fallback options or our cache; pi's built-in `web_fetch` remains available for standalone use.

### Smart-Fetch Engine Architecture

Internal module under `src/engine/`:

```
src/engine/
  constants.ts      — Default values (browser, os, maxChars, timeout, concurrency)
  dependencies.ts   — wreq-js + defuddle runtime dependency injection
  dom.ts           — linkedom HTML parsing + polyfills for defuddle
  extract.ts       — Fetch + extraction pipeline (defuddleFetch)
  format.ts        — Output formatting (markdown/text/html/json) + truncation + error text builders
  profiles.ts      — wreq-js browser profile resolution (latest Chrome)
  types.ts         — FetchOptions, FetchResult, FetchError, BatchFetchResult, FetchExecutionHooks, etc.
```

**Pipeline flow per URL:**

1. Validate URL (http/https only)
2. wreq-js fetch with browser TLS fingerprint + HTTP/2
   - onRequestEvent → progress updates (connecting → waiting → loading)
3. Check Content-Disposition → stream to temp file if attachment/binary
4. Content type routing:
   - JSON → pretty-print + truncate
   - Plain text → render + truncate
   - HTML → continue to extraction
   - Non-textual → stream to temp file
5. HTML extraction:
   - Check client-side `<meta>` redirects → follow (max 5)
   - Defuddle extract → clean markdown
   - Fallback: DOM text extraction
   - Fallback: DOM markdown rendering
   - Check alternate `<link rel="alternate">` → follow (max 3)
6. Truncate to maxChars
7. Return FetchResult with full metadata (title, author, published, site, language, wordCount)

**Error model:**

```typescript
type FetchErrorCode =
  | "invalid_url" | "unsupported_protocol" | "http_error"
  | "unexpected_response" | "timeout" | "network_error"
  | "processing_error" | "download_error" | "no_content"
  | "too_many_redirects";

type FetchErrorPhase =
  | "validation" | "connecting" | "waiting"
  | "loading" | "processing" | "unknown";

interface FetchError {
  error: string;              // Human-readable message
  code: FetchErrorCode;       // Structured error category
  phase: FetchErrorPhase;     // Where in the pipeline it failed
  retryable: boolean;         // Can the agent retry?
  timeoutMs?: number;         // Configured timeout
  url?: string;               // Original URL
  finalUrl?: string;          // Final URL after redirects
  statusCode?: number;        // HTTP status code
  statusText?: string;        // HTTP status text
  mimeType?: string;          // Response content type
  contentLength?: number;     // Expected response size
  downloadedBytes?: number;   // Bytes downloaded before failure
}
```

### Batch Execution

When `url` is an array:

1. Normalize URLs into per-item request objects with shared options
2. Create per-item progress tracker (initial: all `queued`)
3. Spin up N workers bounded by `batchConcurrency` (default 8)
4. Each worker picks next URL from queue, runs smart-fetch pipeline
5. Progress updates streamed via `onUpdate`:
   - Per-item status: `queued → connecting → waiting → loading → processing → done/error`
   - Per-item progress: 0% → 100% driven by wreq-js transport events
6. Results collected in input order
7. Return BatchFetchResult with per-item success/error details

### TUI Progress Renderers

Custom `renderCall` and `renderResult` registered on the tool.

**Single URL in progress** (isPartial=true):
```
⠋ https://example.com/article...  connecting  [███░░░░░░░]
```

**Single URL complete** (isPartial=false):
- Metadata preview: title, published date
- Content preview (7 lines) with expand/collapse via Ctrl+O
- Full content available on expand

**Batch in progress** (isPartial=true):
```
batch_web_content_read 3/5 done · ok 3 · err 0 · concurrency 4
⠋ https://example.com/article...  connecting  [███░░░░░░░]
⠙ https://news.ycombinator.com/... extracting  [███████░░░]
✓ https://docs.python.org/3/...  done         [██████████]
```

**Batch complete** (isPartial=false):
- Summary header with total/succeeded/failed counts
- Per-item expand/collapse for content preview
- Error items show compact error summary

### Settings Integration

New smart-fetch defaults in `~/.unipi/config/web-api/config.json`:

```json
{
  "smartFetchDefaultBrowser": "chrome_145",
  "smartFetchDefaultOs": "windows",
  "smartFetchDefaultMaxChars": 50000,
  "smartFetchDefaultTimeoutMs": 15000,
  "smartFetchDefaultBatchConcurrency": 8,
  "smartFetchDefaultRemoveImages": false,
  "smartFetchDefaultIncludeReplies": "extractors"
}
```

Project `.pi/settings.json` takes precedence over global settings.

The `/unipi:web-settings` TUI command adds a "Smart Fetch Defaults" section for configuring these values.

### Dependencies

**New direct dependencies** (from agent-smart-fetch core):

| Package | Version | Purpose |
|---|---|---|
| `wreq-js` | `^2.3.0` | Browser-grade TLS fingerprinting (Rust native bindings) |
| `defuddle` | `^0.18.1` | Intelligent content extraction from HTML |
| `linkedom` | `^0.18.12` | Server-side DOM parsing (needed by defuddle) |
| `lodash` | `^4.17.21` | `deburr` for filename sanitization in downloads |
| `mime-types` | `^2.1.35` | MIME type → extension mapping for file downloads |

**New peer dependency**:

| Package | Purpose |
|---|---|
| `@mariozechner/pi-tui` | TUI components for progress renderers |

**Existing** (kept): `@pi-unipi/core`, `@sinclair/typebox`, `@mariozechner/pi-coding-agent`

### File Structure

```
packages/web-api/src/
  index.ts                    — Extension entry (updated tool registration)
  tools.ts                    — Tool definitions (multi_web_content_read replaces web_read)
  commands.ts                 — Commands (updated settings dialog)
  cache.ts                    — Cache layer (stays)
  settings.ts                 — Settings (adds smart-fetch defaults)
  engine/                     — NEW: Smart-fetch engine
    constants.ts              — Default values
    dependencies.ts            — wreq-js + defuddle runtime deps
    dom.ts                    — linkedom parsing + polyfills
    extract.ts                — Fetch + extraction pipeline (defuddleFetch)
    format.ts                 — Output formatting + error text builders
    profiles.ts               — Browser profile resolution
    types.ts                   — FetchResult, FetchError, BatchFetchResult, etc.
  providers/                  — Kept for search + read fallback
    base.ts                   — Stays
    registry.ts               — Stays
    duckduckgo.ts             — Stays
    jina-search.ts            — Stays
    jina-reader.ts             — Stays (read provider, now rank 1)
    serpapi.ts                — Stays
    tavily.ts                 — Stays
    firecrawl.ts              — Stays (read provider, now rank 2)
    perplexity.ts             — Stays (search + read + summarize)
    llm-summarize.ts          — Stays
  tui/                        — TUI components
    settings-dialog.ts        — Updated: add smart-fetch defaults section
    provider-selector.ts       — Stays
    progress.ts               — NEW: batch progress renderer
    result.ts                  — NEW: single result renderer with expand/collapse
  skills/
    web/SKILL.md              — Updated
```

## Implementation Checklist

- [ ] Add new dependencies to package.json (wreq-js, defuddle, linkedom, lodash, mime-types, @mariozechner/pi-tui) — covered in Task 1
- [ ] Create engine/types.ts — FetchResult, FetchError, FetchOptions, BatchFetchResult, FetchExecutionHooks, progress types — covered in Task 2
- [ ] Create engine/constants.ts — Default values (browser, os, maxChars, timeout, concurrency, headers) — covered in Task 3
- [ ] Create engine/dependencies.ts — wreq-js + defuddle runtime dependency injection — covered in Task 4
- [ ] Create engine/dom.ts — linkedom HTML parsing + polyfills for defuddle compatibility — covered in Task 4
- [ ] Create engine/profiles.ts — wreq-js browser profile resolution (latest Chrome detection) — covered in Task 3
- [ ] Create engine/format.ts — Output formatting (markdown/text/html/json), truncation, error text builders, batch result formatting — covered in Task 5
- [ ] Create engine/extract.ts — Core fetch+extract pipeline (defuddleFetch): URL validation, wreq-js fetch with progress hooks, content-type routing, defuddle extraction, DOM fallbacks, client-side redirect following, alternate link fallback, file download streaming — covered in Task 6
- [ ] Create tui/progress.ts — Batch progress renderer: spinner animation, per-item progress bars, responsive width layout, status glyphs — covered in Task 10
- [ ] Create tui/result.ts — Single result renderer: metadata preview, content preview with expand/collapse, file result display, error display — covered in Task 10
- [ ] Update tools.ts — Replace web_read with multi_web_content_read: union type for url (string | string[]), source parameter for provider routing, smart-fetch engine as default, batch execution with concurrency, custom renderCall/renderResult, progress streaming via onUpdate — covered in Task 9
- [ ] Update tools.ts — Adjust web_search and web_llm_summarize tool registrations to reflect new tool surface — covered in Task 9
- [ ] Update settings.ts — Add smart-fetch default settings (browser, os, maxChars, timeout, concurrency, removeImages, includeReplies), add loadSmartFetchSettings function with global + project precedence — covered in Task 8
- [ ] Update commands.ts — Update /unipi:web-settings to include smart-fetch defaults configuration section — covered in Task 12
- [ ] Update index.ts — Remove web_read from WEB_TOOLS, add multi_web_content_read, update module announcement — covered in Task 13
- [ ] Update providers/base.ts — Update ProviderRanking: read rank 0 is now reserved for smart-fetch engine, existing providers shift to rank 1+ — covered in Task 11
- [ ] Update SKILL.md — Document multi_web_content_read tool, updated provider rankings, smart-fetch features — covered in Task 14
- [ ] Update README.md — Document new tool, architecture, dependencies, settings — covered in Task 14

## Open Questions

- Should `wreq-js` require a Rust native build step, or does it ship prebuilt binaries? Need to verify for npm install compatibility.
- How does the cache layer interact with the smart-fetch engine? Should cached results use the same file-based cache, or should we introduce a smarter cache key that includes browser/format/maxChars?
- Should `multi_web_content_read` support a `refresh` parameter to bypass cache?
- The `url: string | string[]` union type may not render cleanly in some LLM tool-use schema validators. Need to verify TypeBox `Type.Union` support in pi's tool registration.

## Out of Scope

- Replacing or modifying the search provider system
- Changes to `web_llm_summarize` (it serves a different purpose — token-saving via API summarization)
- Removing any existing providers
- Modifying pi's built-in `web_fetch`/`batch_web_fetch` tools
- Docker/container compatibility for wreq-js native bindings
- JavaScript execution / headless browser rendering (defuddle does not execute JS)
