---
title: "Web API — Implementation Plan"
type: plan
date: 2026-04-27
specs:
  - .unipi/docs/specs/2026-04-27-web-api-design.md
---

# Web API — Implementation Plan

## Overview

Create `@pi-unipi/web-api` extension providing agent tools (`web-search`, `web-read`, `web-llm-summarize`) with provider-based backend selection, API key management via TUI, and smart source ranking. Includes cache layer with manual invalidation command.

**Decisions:**
- Package name: `@pi-unipi/web-api` (rename existing `WEBTOOLS` constant to `WEB_API`)
- Rate limiting: deferred (not in scope)
- Cache invalidation: manual clear command `/unipi:web-cache-clear`

## Tasks

- completed: Task 1 — Package Setup & Core Rename
  - Description: Create `@pi-unipi/web-api` package structure, rename `WEBTOOLS` to `WEB_API` in core constants
  - Dependencies: None
  - Acceptance Criteria: Package compiles, constant renamed, extension entry exports correctly
  - Steps:
    1. Create `packages/web-api/` directory with `package.json`
    2. Create `src/` directory structure (providers/, tools/, tui/)
    3. Rename `WEBTOOLS` to `WEB_API` in `packages/core/constants.ts` and update MODULES
    4. Create `src/index.ts` extension entry skeleton
    5. Update `packages/web-api/package.json` with dependencies and pi extension config

- completed: Task 2 — Provider Base Interface & Registry
  - Description: Define provider interface, registry, and capability types
  - Dependencies: Task 1
  - Acceptance Criteria: Types compile, registry can register/retrieve providers
  - Steps:
    1. Create `src/providers/base.ts` with `WebProvider` interface
    2. Define capability types: `"search" | "read" | "summarize"`
    3. Define ranking structure: `{ search: number; read: number; summarize: number }`
    4. Create `src/providers/registry.ts` with `ProviderRegistry` class
    5. Implement `register()`, `getProvider()`, `getProvidersForCapability()`, `getRankedProviders()`
    6. Export registry singleton

- completed: Task 3 — DuckDuckGo Provider (Free Search)
  - Description: Implement DuckDuckGo search provider (free, no API key)
  - Dependencies: Task 2
  - Acceptance Criteria: Can search via DuckDuckGo, returns structured results
  - Steps:
    1. Create `src/providers/duckduckgo.ts`
    2. Implement `WebProvider` interface with `search` capability
    3. Use `duck-duck-scrape` or HTTP scraping for search
    4. Parse results into standard format: `{ title, url, snippet }`
    5. Set ranking: `{ search: 1, read: 0, summarize: 0 }`
    6. Register in provider registry

- completed: Task 4 — Jina AI Search Provider (Freemium Search)
  - Description: Implement Jina AI Search provider
  - Dependencies: Task 2
  - Acceptance Criteria: Can search via Jina AI, handles API key optionally
  - Steps:
    1. Create `src/providers/jina-search.ts`
    2. Implement `WebProvider` interface with `search` capability
    3. Use Jina Search API endpoint
    4. Parse results into standard format
    5. Set ranking: `{ search: 2, read: 0, summarize: 0 }`
    6. Handle optional API key (higher rate limits with key)

- completed: Task 5 — Jina AI Reader Provider (Freemium Read)
  - Description: Implement Jina AI Reader provider for URL content extraction
  - Dependencies: Task 2
  - Acceptance Criteria: Can read URL content, returns markdown
  - Steps:
    1. Create `src/providers/jina-reader.ts`
    2. Implement `WebProvider` interface with `read` capability
    3. Use Jina Reader API (`r.jina.ai/{url}`)
    4. Return extracted content as markdown
    5. Set ranking: `{ search: 0, read: 1, summarize: 0 }`
    6. Handle optional API key

- completed: Task 6 — SerpAPI Provider (Paid Search)
  - Description: Implement SerpAPI provider for Google search
  - Dependencies: Task 2
  - Acceptance Criteria: Can search via SerpAPI, requires API key
  - Steps:
    1. Create `src/providers/serpapi.ts`
    2. Implement `WebProvider` interface with `search` capability
    3. Use SerpAPI Google Search endpoint
    4. Parse results into standard format
    5. Set ranking: `{ search: 3, read: 0, summarize: 0 }`
    6. Mark `requiresApiKey: true`, `apiKeyEnv: "SERPAPI_KEY"`

- completed: Task 7 — Tavily Provider (Paid Search)
  - Description: Implement Tavily provider for AI-optimized search
  - Dependencies: Task 2
  - Acceptance Criteria: Can search via Tavily, requires API key
  - Steps:
    1. Create `src/providers/tavily.ts`
    2. Implement `WebProvider` interface with `search` capability
    3. Use Tavily Search API
    4. Parse results into standard format
    5. Set ranking: `{ search: 4, read: 0, summarize: 0 }`
    6. Mark `requiresApiKey: true`, `apiKeyEnv: "TAVILY_API_KEY"`

- completed: Task 8 — Firecrawl Provider (Paid Read)
  - Description: Implement Firecrawl provider for advanced web scraping
  - Dependencies: Task 2
  - Acceptance Criteria: Can read URL content via Firecrawl, requires API key
  - Steps:
    1. Create `src/providers/firecrawl.ts`
    2. Implement `WebProvider` interface with `read` capability
    3. Use Firecrawl API for content extraction
    4. Return extracted content as markdown
    5. Set ranking: `{ search: 0, read: 2, summarize: 0 }`
    6. Mark `requiresApiKey: true`, `apiKeyEnv: "FIRECRAWL_API_KEY"`

- completed: Task 9 — Perplexity Provider (Paid Search + Summarize)
  - Description: Implement Perplexity provider for search and summarization
  - Dependencies: Task 2
  - Acceptance Criteria: Can search and summarize via Perplexity, requires API key
  - Steps:
    1. Create `src/providers/perplexity.ts`
    2. Implement `WebProvider` interface with `search`, `read`, `summarize` capabilities
    3. Use Perplexity API for search and chat completions
    4. Parse results into standard format
    5. Set ranking: `{ search: 5, read: 3, summarize: 1 }`
    6. Mark `requiresApiKey: true`, `apiKeyEnv: "PERPLEXITY_API_KEY"`

- completed: Task 10 — LLM Summarize Provider
  - Description: Implement LLM-based summarization using pi's existing LLM
  - Dependencies: Task 2
  - Acceptance Criteria: Can summarize content using LLM, no external API key needed
  - Steps:
    1. Create `src/providers/llm-summarize.ts`
    2. Implement `WebProvider` interface with `summarize` capability
    3. Use pi's LLM context to summarize fetched content
    4. Set ranking: `{ search: 0, read: 0, summarize: 2 }`
    5. Mark `requiresApiKey: false` (uses existing LLM)

- completed: Task 11 — Settings Storage & Management
  - Description: Create settings storage for API keys and provider config
  - Dependencies: Task 1
  - Acceptance Criteria: Settings persist to auth.json/config.json, can load/save/validate
  - Steps:
    1. Create `src/settings.ts` with `WebApiSettings` class
    2. Define `auth.json` structure at `~/.unipi/config/web-api/auth.json`
    3. Define `config.json` structure at `~/.unipi/config/web-api/config.json`
    4. Implement `loadAuth()`, `saveAuth()`, `loadConfig()`, `saveConfig()`
    5. Implement API key validation with test request
    6. Create directories if not exist on first load
    7. Add `.gitignore` for auth.json

- completed: Task 12 — Agent Tools Registration
  - Description: Register `web-search`, `web-read`, `web-llm-summarize` tools
  - Dependencies: Tasks 2-10, Task 11
  - Acceptance Criteria: Tools appear in agent tool list, parameters validated, smart provider selection works
  - Steps:
    1. Create `src/tools.ts` with tool definitions
    2. Define `web-search` tool with `query` and optional `source` parameters
    3. Define `web-read` tool with `url` and optional `source` parameters
    4. Define `web-llm-summarize` tool with `url`, optional `prompt`, optional `source`
    5. Implement smart provider selection (lowest rank available when source omitted)
    6. Implement error handling for missing providers/API keys
    7. Register tools in extension entry

- completed: Task 13 — Cache Layer with Configurable TTL
  - Description: Implement web content caching with TTL and manual invalidation
  - Dependencies: Task 11
  - Acceptance Criteria: Reads cached, TTL configurable, manual clear command works
  - Steps:
    1. Create `src/cache.ts` with `WebCache` class
    2. Use `~/.unipi/config/web-api/cache/` for cache storage
    3. Implement `get(key)`, `set(key, data, ttlMs)`, `clear()`, `clearExpired()`
    4. Default TTL: 3600000ms (1 hour), configurable in config.json
    5. Cache key: hash of URL + provider
    6. Implement `web-cache-clear` command handler

- completed: Task 14 — Settings TUI Dialog
  - Description: Build interactive TUI for API key management
  - Dependencies: Task 11
  - Acceptance Criteria: TUI shows providers, allows API key entry, validates on save
  - Steps:
    1. Create `src/tui/settings-dialog.ts`
    2. Create `src/tui/provider-selector.ts`
    3. Use pi TUI components: `SelectList`, custom input, `DynamicBorder`
    4. Show provider list with status indicators (✓/✗)
    5. Implement API key input with validation
    6. Register `/unipi:web-settings` command

- completed: Task 15 — Cache Clear Command
  - Description: Register `/unipi:web-cache-clear` command
  - Dependencies: Task 13
  - Acceptance Criteria: Command clears all cached web content
  - Steps:
    1. Register `/unipi:web-cache-clear` command in extension entry
    2. Call `WebCache.clear()` on command
    3. Show confirmation with items cleared count
    4. Emit status notification

- completed: Task 16 — Subagent Integration
  - Description: Event-based module discovery and tool injection for subagents
  - Dependencies: Tasks 12, 13
  - Acceptance Criteria: Subagents automatically get web tools when web-api is present
  - Steps:
    1. Emit `unipi:module:ready` on session_start with tools list
    2. Add web skill guidelines to tool injection
    3. Test that spawned subagents have web tools available

- completed: Task 17 — Web Skill Documentation
  - Description: Create `skills/web/SKILL.md` with usage guidelines
  - Dependencies: Tasks 12, 16
  - Acceptance Criteria: Skill file loads, provides correct usage guidance
  - Steps:
    1. Create `skills/web/SKILL.md` following spec template
    2. Document `web-search`, `web-read`, `web-llm-summarize` usage
    3. Document provider selection strategy
    4. Document cost awareness
    5. Register skill path in extension entry

- completed: Task 18 — Info Screen Integration
  - Description: Register info group for web-api in info screen
  - Dependencies: Tasks 11, 12
  - Acceptance Criteria: Web API info shows in `/unipi:info` dashboard
  - Steps:
    1. Register info group with id `web-api` in extension entry
    2. Show configured providers count
    3. Show cache stats (items, size)
    4. Show last search/read activity

- completed: Task 19 — Extension Entry Assembly
  - Description: Wire all components into extension entry point
  - Dependencies: All previous tasks
  - Acceptance Criteria: Extension loads, all tools/commands registered, lifecycle handled
  - Steps:
    1. Import all providers and register in registry
    2. Import and register all tools
    3. Import and register all commands
    4. Handle `session_start`: init settings, emit MODULE_READY, register info group
    5. Handle `session_shutdown`: cleanup resources
    6. Register skills directory
    7. Export default extension function

- completed: Task 20 — README Documentation
  - Description: Write package README with setup and usage instructions
  - Dependencies: Task 19
  - Acceptance Criteria: README explains setup, configuration, and usage
  - Steps:
    1. Write overview and features
    2. Document provider setup (API keys)
    3. Document tool usage examples
    4. Document `/unipi:web-settings` command
    5. Document `/unipi:web-cache-clear` command
    6. Add troubleshooting section

## Sequencing

```
Task 1 (Setup & Rename)
    ↓
Task 2 (Provider Base & Registry)
    ↓
Tasks 3-10 (Providers) ← Parallel
    ↓
Task 11 (Settings Storage)
    ↓
Task 12 (Tool Registration) ← Depends on providers + settings
    ↓
Task 13 (Cache Layer) ← Depends on settings
    ↓
Task 14 (Settings TUI) ← Depends on settings
    ↓
Task 15 (Cache Clear Command) ← Depends on cache
    ↓
Task 16 (Subagent Integration) ← Depends on tools
    ↓
Task 17 (Web Skill) ← Depends on tools
    ↓
Task 18 (Info Screen) ← Depends on settings + tools
    ↓
Task 19 (Extension Entry) ← Depends on all
    ↓
Task 20 (README) ← Final
```

**Parallel opportunities:**
- Tasks 3-10 can be implemented in parallel (all depend only on Task 2)
- Tasks 14, 13, 16, 17 can be parallelized after Task 12

## Risks

1. **Provider API changes:** External APIs may change; providers should handle gracefully
2. **Rate limiting:** Deferred but may hit limits during testing
3. **Cache storage:** Large cache could consume disk space; consider size limits
4. **LLM summarization cost:** Using pi's LLM for summarize could be expensive for large content
5. **TUI complexity:** Settings dialog may need iteration for good UX
