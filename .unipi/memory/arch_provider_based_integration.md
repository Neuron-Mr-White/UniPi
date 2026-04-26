---
title: arch_provider_based_integration
tags: [architecture, providers, extension, api]
project: unipi
created: 2026-04-27T00:00:00Z
updated: 2026-04-27T00:00:00Z
type: pattern
---

# Architecture: Provider-Based Integration Pattern

When building extensions that integrate external APIs (search, AI, scraping, etc.), use a provider-based architecture.

## Pattern

```
Extension
├── providers/
│   ├── base.ts        # Interface + types
│   ├── registry.ts    # Singleton registry
│   └── {provider}.ts  # Each API implementation
├── settings.ts        # Auth + config storage
├── tools.ts           # Agent tool registration
└── index.ts           # Extension entry
```

## Key Design

### Provider Interface
```typescript
interface WebProvider {
  id: string;
  name: string;
  capabilities: string[];      // What this provider can do
  requiresApiKey: boolean;
  apiKeyEnv?: string;          // Env var name
  ranking: Record<string, number>;  // Lower = simpler/cheaper
  config: Record<string, unknown>;
}
```

### Registry Pattern
- Singleton registry for provider lookup
- `getRankedProviders(capability)` for smart selection
- `getBestProvider(capability)` returns lowest-ranked available

### Capability Ranking
- Lower rank = simpler/cheaper provider (auto-selected)
- Higher rank = more capable/expensive (opt-in)
- Rank 0 = provider doesn't support that capability

## Benefits
- Easy to add new providers (just implement interface + register)
- Smart auto-selection based on cost/complexity
- Consistent error handling across providers
- Provider-specific config isolated in each implementation

## Example: web-api
- Search: DuckDuckGo (1) → Jina (2) → SerpAPI (3) → Tavily (4) → Perplexity (5)
- Read: Jina Reader (1) → Firecrawl (2) → Perplexity (3)
- Summarize: Perplexity (1) → LLM Summarize (2)

## Use When
- Extension integrates multiple external APIs
- APIs have different cost/complexity tradeoffs
- Users may not have all API keys configured
- Want smart fallback/selection behavior
