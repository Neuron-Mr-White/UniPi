---
title: "Web API — @pi-unipi/web-api Extension"
type: brainstorm
date: 2026-04-27
---

# Web API — @pi-unipi/web-api Extension

## Problem Statement

Pi coding agent lacks built-in web access tools. Users need to search the web, read web content, and summarize web pages using various providers (SerpAPI, DuckDuckGo, Tavily, Perplexity, Firecrawl, Jina AI Reader, Jina AI Search), but there's no unified way to manage these providers, configure API keys, or use them as agent tools.

**Root need:** A web tool integration extension that provides agent tools (`web-search`, `web-llm-summarize`, `web-read`) with provider-based backend selection, API key management via interactive TUI, and smart source ranking based on use case.

## Context

**Existing patterns studied:**
- `@pi-unipi/subagents`: Event-based module discovery, TUI widget integration, tool registration pattern
- `@pi-unipi/memory`: Settings persistence, tool registration with TypeBox schemas
- Pi TUI: `SelectList`, `SettingsList`, `BorderedLoader` components for interactive UI
- Pi extension API: `ctx.ui.custom()` for TUI, `pi.registerTool()` for tools, `pi.events` for discovery

**Provider landscape:**
- **Search APIs:** SerpAPI (paid), Tavily (paid), Perplexity (paid), DuckDuckGo (free), Jina AI Search (freemium)
- **Content APIs:** Firecrawl (paid), Jina AI Reader (freemium), Perplexity (can summarize)
- **LLM Summarize:** Uses existing LLM with web content as context (cost: LLM tokens)

**Key insight:** Different providers excel at different use cases. Source ranking should reflect this:
- Lower `source` value = simpler/cheaper providers (DuckDuckGo for quick search)
- Higher `source` value = more capable/expensive providers (Tavily for research, Perplexity for summaries)

## Chosen Approach

**Provider-based architecture** with:
1. Provider registry (defines capabilities, API requirements, ranking)
2. Settings TUI for API key management
3. Agent tools with smart source selection
4. Event-based module discovery for subagent integration

## Why This Approach

- **Provider abstraction:** Consistent interface across different APIs, easy to add new providers
- **Source ranking:** Agent can choose provider based on task complexity/cost
- **TUI settings:** Interactive API key management without manual config files
- **Event integration:** Subagents automatically get web tools when web-api module is present

## Design

### Architecture

```
@pi-unipi/web-api/
├── src/
│   ├── index.ts              # Extension entry, tool registration
│   ├── providers/
│   │   ├── registry.ts       # Provider registry and capabilities
│   │   ├── base.ts           # Base provider interface
│   │   ├── serpapi.ts        # SerpAPI implementation
│   │   ├── duckduckgo.ts     # DuckDuckGo implementation
│   │   ├── tavily.ts         # Tavily implementation
│   │   ├── perplexity.ts     # Perplexity implementation
│   │   ├── firecrawl.ts      # Firecrawl implementation
│   │   ├── jina-reader.ts    # Jina AI Reader implementation
│   │   └── jina-search.ts    # Jina AI Search implementation
│   ├── tools.ts              # Agent tool definitions
│   ├── settings.ts           # Settings storage and management
│   └── tui/
│       ├── settings-dialog.ts # Interactive settings TUI
│       └── provider-selector.ts # Provider selection component
├── package.json
└── README.md
```

### Provider Registry

Each provider defines:

```typescript
interface WebProvider {
  id: string;
  name: string;
  capabilities: ("search" | "read" | "summarize")[];
  requiresApiKey: boolean;
  apiKeyEnv?: string;  // e.g., "SERPAPI_KEY"
  ranking: {
    search: number;    // 1 = best for simple search, higher = more complex
    read: number;      // 1 = best for simple reads, higher = more capable
    summarize: number; // 1 = cheapest, higher = more expensive
  };
  config: Record<string, unknown>;  // Provider-specific config
}
```

**Provider rankings:**

| Provider | search | read | summarize | Cost |
|----------|--------|------|-----------|------|
| DuckDuckGo | 1 | - | - | Free |
| Jina AI Search | 2 | - | - | Freemium |
| SerpAPI | 3 | - | - | Paid |
| Tavily | 4 | - | - | Paid |
| Jina AI Reader | - | 1 | - | Freemium |
| Firecrawl | - | 2 | - | Paid |
| Perplexity | 5 | 3 | 1 | Paid |
| LLM Summarize | - | - | 2 | LLM cost |

### Agent Tools

#### `web-search`
- **Purpose:** Search the web for information
- **Parameters:**
  - `query`: Search query string
  - `source`: Provider selection (1-N, optional, auto-selected if omitted)
- **Behavior:**
  - If `source` omitted: Use lowest-ranked available provider
  - If `source` specified: Use provider at that rank (if available)
  - If no provider available: Throw error with available providers list

#### `web-read`
- **Purpose:** Read and extract content from a URL
- **Parameters:**
  - `url`: URL to read
  - `source`: Provider selection (1-N, optional)
- **Behavior:**
  - Extract main content, strip navigation/ads
  - Return markdown or structured text

#### `web-llm-summarize`
- **Purpose:** Summarize web content using LLM
- **Parameters:**
  - `url`: URL to summarize (fetches content first)
  - `prompt`: Custom summarization prompt (optional)
  - `source`: Provider selection for content fetch (1-N, optional)
- **Behavior:**
  - Fetch content via `web-read` provider
  - Use LLM to summarize with given prompt
  - Cost: LLM tokens + provider cost

### Settings TUI

**Command:** `/unipi:web-settings`

**Flow:**
1. Show provider list with status (configured/not configured)
2. User selects provider
3. If provider requires API key:
   - Show input field for API key
   - Validate format (if possible)
   - Save or cancel
4. Return to provider list
5. Settings persisted to `~/.unipi/config/web-api/auth.json` and `config.json`

**TUI Components:**
- `SelectList` for provider selection
- Custom input component for API key entry
- `DynamicBorder` for framing
- Status indicators (✓ configured, ✗ not configured)

### Settings Storage

**Locations:**
- **Auth:** `~/.unipi/config/web-api/auth.json` (API keys, gitignored)
- **Config:** `~/.unipi/config/web-api/config.json` (provider settings, tracked)

**auth.json:**
```json
{
  "serpapi": "sk-...",
  "tavily": "tvly-...",
  "perplexity": "pplx-..."
}
```

**config.json:**
```json
{
  "providers": {
    "serpapi": { "enabled": true },
    "duckduckgo": { "enabled": true },
    "tavily": { "enabled": true }
  },
  "cache": {
    "enabled": true,
    "ttlMs": 3600000
  }
}
```

**Validation:** API keys are validated with a test request (HTTP 200) on save.
**Caching:** Web reads are cached with configurable TTL (default 1 hour).

### Subagent Integration

**Event-based discovery:**
- `@pi-unipi/web-api` emits `unipi:module:ready` on load
- `@pi-unipi/subagents` listens for `unipi:module:ready` events
- When `@pi-unipi/web-api` detected, subagents inject web tools into spawned agents

**Tool injection:**
- Subagent manager checks for web-api module presence
- If present, adds `web-search`, `web-read`, `web-llm-summarize` to agent tool list
- Agent skills are also injected with web usage guidelines

### Error Handling

**No provider available:**
```typescript
throw new Error(
  `No ${toolType} provider available.\n` +
  `Configure providers via /unipi:web-settings\n` +
  `Available providers: ${availableProviders.join(", ")}`
);
```

**API key missing:**
```typescript
throw new Error(
  `Provider "${provider.name}" requires an API key.\n` +
  `Configure via /unipi:web-settings`
);
```

**API error:**
```typescript
throw new Error(
  `Provider "${provider.name}" failed: ${error.message}\n` +
  `Try a different provider or check your API key.`
);
```

### Web Skill

**Skill file:** `skills/web/SKILL.md`

```markdown
---
name: web
description: "Web search, read, and summarize tools with provider-based backend"
---

# Web Tools

Use these tools to access web content. Providers are ranked by capability and cost.

## web-search
Search the web. Lower `source` = simpler/cheaper providers.
- Quick facts: source 1-2 (DuckDuckGo, Jina Search)
- Research: source 3-5 (SerpAPI, Tavily, Perplexity)

## web-read
Read URL content. Lower `source` = simpler providers.
- Basic extraction: source 1 (Jina Reader)
- Advanced crawling: source 2 (Firecrawl)

## web-llm-summarize
Summarize URL with LLM. Higher cost (LLM tokens + provider).
- Use for complex content that needs analysis
- Custom prompts supported for targeted summaries

## Provider Selection
- Omit `source` for auto-selection (cheapest available)
- Specify `source` number for specific provider
- If provider unavailable, tool throws descriptive error

## Cost Awareness
- DuckDuckGo: Free (search only)
- Jina: Freemium (search + read)
- SerpAPI/Tavily: Paid (search)
- Firecrawl: Paid (read)
- Perplexity: Paid (search + summarize)
- LLM Summarize: LLM token cost
```

## Implementation Checklist

- [x] Create provider base interface and registry — covered in Task 1-2
- [x] Implement DuckDuckGo provider (free search) — covered in Task 3
- [x] Implement Jina AI Search provider (freemium search) — covered in Task 4
- [x] Implement Jina AI Reader provider (freemium read) — covered in Task 5
- [x] Implement SerpAPI provider (paid search) — covered in Task 6
- [x] Implement Tavily provider (paid search) — covered in Task 7
- [x] Implement Firecrawl provider (paid read) — covered in Task 8
- [x] Implement Perplexity provider (paid search + summarize) — covered in Task 9
- [x] Create settings storage and management — covered in Task 11
- [x] Build settings TUI dialog — covered in Task 14
- [x] Register `web-search` tool — covered in Task 12
- [x] Register `web-read` tool — covered in Task 12
- [x] Register `web-llm-summarize` tool — covered in Task 12
- [x] Add event-based module discovery — covered in Task 16
- [x] Integrate with subagent tool injection — covered in Task 16
- [x] Write web skill documentation — covered in Task 17
- [x] Add info-screen integration — covered in Task 18
- [x] Implement cache layer with configurable TTL — covered in Task 13
- [ ] Test provider fallback and error handling — Manual testing

**Plan:** `.unipi/docs/plans/2026-04-27-web-api-plan.md`

## Resolved Questions

1. **API key validation:** ✅ Validate with test request (HTTP 200) on save
2. **Content caching:** ✅ Cache web reads with configurable TTL (default 1 hour)
3. **Settings location:** ✅ Split auth/config: `~/.unipi/config/web-api/auth.json` + `config.json`

## Open Questions

1. **Rate limiting:** How to handle provider rate limits? Queue requests or fail fast?
2. **Cache invalidation:** Should manual cache clear command be exposed?

## Out of Scope

- Building custom web crawlers
- Browser automation (Puppeteer/Playwright)
- Web scraping with login/auth
- Real-time streaming of web content
- Webhook/integration with external services
- Modifying pi core web capabilities

## Next Steps

1. Proceed to `/unipi:plan` for implementation planning
2. Research provider API details and rate limits
3. Design TUI mockups for settings dialog
4. Define provider ranking heuristics in detail