# @pi-unipi/web-api

Web search, read, and summarize tools with provider-based backend selection for Pi coding agent.

## Overview

`@pi-unipi/web-api` provides agent tools for web access:

- **web_search** — Search the web using various providers
- **web_read** — Extract content from URLs
- **web_llm_summarize** — Summarize web content using LLM

Providers are ranked by capability and cost, allowing smart auto-selection.

## Features

- **Provider-based architecture** — Multiple search/read providers with unified interface
- **Smart selection** — Auto-select cheapest available provider
- **API key management** — Interactive TUI for key configuration
- **Caching** — Web content cached with configurable TTL
- **Subagent integration** — Tools automatically available to spawned subagents

## Installation

```bash
npm install @pi-unipi/web-api
```

Add to your pi configuration:

```json
{
  "pi": {
    "extensions": [
      "node_modules/@pi-unipi/web-api/src/index.ts"
    ]
  }
}
```

## Providers

### Search Providers

| Provider | Rank | Cost | API Key |
|----------|------|------|---------|
| DuckDuckGo | 1 | Free | No |
| Jina AI Search | 2 | Freemium | Optional |
| SerpAPI | 3 | Paid | Required |
| Tavily | 4 | Paid | Required |
| Perplexity | 5 | Paid | Required |

### Read Providers

| Provider | Rank | Cost | API Key |
|----------|------|------|---------|
| Jina AI Reader | 1 | Freemium | Optional |
| Firecrawl | 2 | Paid | Required |
| Perplexity | 3 | Paid | Required |

### Summarize Providers

| Provider | Rank | Cost | API Key |
|----------|------|------|---------|
| Perplexity | 1 | Paid | Required |
| LLM Summarize | 2 | LLM tokens | No |

## Configuration

### API Keys

Configure API keys via the interactive settings command:

```
/unipi:web-settings
```

Or set environment variables:

```bash
export SERPAPI_KEY="your-key"
export TAVILY_API_KEY="your-key"
export FIRECRAWL_API_KEY="your-key"
export PERPLEXITY_API_KEY="your-key"
export JINA_API_KEY="your-key"
```

### Settings Files

- **Auth:** `~/.unipi/config/web-api/auth.json` (API keys, gitignored)
- **Config:** `~/.unipi/config/web-api/config.json` (provider settings)

## Usage

### Web Search

```
# Auto-select cheapest provider
web_search(query: "TypeScript generics")

# Use specific provider
web_search(query: "latest AI research", source: 4)  # Tavily
```

### Web Read

```
# Auto-select provider
web_read(url: "https://example.com/article")

# Use specific provider
web_read(url: "https://example.com/spa", source: 2)  # Firecrawl
```

### Web Summarize

```
# Auto-summarize
web_llm_summarize(url: "https://example.com/long-article")

# Custom prompt
web_llm_summarize(url: "https://example.com/research", prompt: "Extract key findings")
```

## Commands

### /unipi:web-settings

Interactive settings dialog for managing providers and API keys.

- **Auto-enable on key input** — provider is automatically enabled when you add a valid API key (no extra toggle step)
- **Cursor memory** — last configured provider moves to the top of the list when you return to the menu

### /unipi:web-cache-clear

Clear all cached web content.

## Cache

- Default TTL: 1 hour
- Cache location: `~/.unipi/config/web-api/cache/`
- Automatic for web_read operations

## Troubleshooting

### No provider available

If you see "No search provider available":

1. Run `/unipi:web-settings`
2. Add API keys for paid providers (they auto-enable on key input)
3. Or manually enable a free provider

### API key invalid

If API key validation fails:

1. Check the key is correct
2. Verify the key has sufficient permissions
3. Check provider status at their website

### Rate limiting

If you hit rate limits:

1. Add an API key for higher limits
2. Use a different provider
3. Wait and retry

## Development

```bash
# Type check
npm run typecheck

# Build
npm run build
```

## License

MIT
