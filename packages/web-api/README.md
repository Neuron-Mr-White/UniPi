# @pi-unipi/web-api

Web search, read, and summarize tools with provider-based backend selection for Pi coding agent.

## Overview

`@pi-unipi/web-api` provides agent tools for web access:

- **web_search** — Search the web using various providers
- **multi_web_content_read** — Extract content from URLs using the local smart-fetch engine (default) or provider fallbacks
- **web_llm_summarize** — Summarize web content using LLM

The read path uses a **smart-fetch engine** by default — free, local, no API key required.

## Features

- **Smart-Fetch Engine** — Local content extraction with browser-grade TLS fingerprinting
- **Provider-based architecture** — Multiple search/read providers with unified interface
- **Smart selection** — Auto-select cheapest available provider
- **Batch reading** — Fetch multiple URLs concurrently with progress
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

## Smart-Fetch Engine

The smart-fetch engine is a local content extraction pipeline:

| Component | Purpose |
|-----------|---------|
| **wreq-js** | Browser-grade TLS fingerprinting (bypasses Cloudflare) |
| **defuddle** | Intelligent content extraction from HTML |
| **linkedom** | Server-side DOM parsing |

**Features:**
- No API key required
- Browser-level anti-bot bypass
- Clean markdown output with metadata (title, author, site, word count)
- Batch concurrent fetching with progress
- Client-side meta redirect following
- Multiple output formats (markdown, HTML, text, JSON)

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
| **Smart-Fetch Engine** | 0 | Free | No |
| Jina AI Reader | 1 | Freemium | Optional |
| Firecrawl | 2 | Paid | Required |
| Perplexity | 3 | Paid | Required |

**Note:** Rank 0 is the smart-fetch engine (default). Provider fallbacks are available via `source` parameter.

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

### Smart-Fetch Defaults

Configure default browser profile, OS, max chars, timeout, etc. via:

```
/unipi:web-settings → "Smart Fetch Defaults"
```

### Settings Files

- **Auth:** `~/.unipi/config/web-api/auth.json` (API keys, gitignored)
- **Config:** `~/.unipi/config/web-api/config.json` (provider settings, smart-fetch defaults)

## Usage

### Web Search

```
# Auto-select cheapest provider
web_search(query: "TypeScript generics")

# Use specific provider
web_search(query: "latest AI research", source: 4)  # Tavily
```

### Multi Web Content Read

```
# Single URL (uses smart-fetch engine by default)
multi_web_content_read(url: "https://example.com/article")

# Batch URLs
multi_web_content_read(url: ["https://example.com/a", "https://example.com/b"])

# Use provider fallback (Jina Reader)
multi_web_content_read(url: "https://example.com/article", source: 1)

# Custom options
multi_web_content_read(url: "https://example.com/article", format: "json", maxChars: 10000)

# Advanced: custom browser profile
multi_web_content_read(url: "https://example.com/article", browser: "chrome_145", os: "windows")
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

Interactive settings dialog for managing providers, API keys, and smart-fetch defaults.

- **Auto-enable on key input** — provider is automatically enabled when you add a valid API key
- **Smart-fetch configuration** — set default browser, OS, timeout, etc.
- **Cursor memory** — last configured provider moves to the top of the list

### /unipi:web-cache-clear

Clear all cached web content.

## Cache

- Default TTL: 1 hour
- Cache location: `~/.unipi/config/web-api/cache/`
- Smart-fetch cache keys include URL + browser + format + maxChars
- Automatic for all read operations

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| wreq-js | ^2.3.0 | TLS fingerprinting |
| defuddle | ^0.18.1 | Content extraction |
| linkedom | ^0.18.12 | Server-side DOM |
| lodash | ^4.17.21 | Filename sanitization |
| mime-types | ^2.1.35 | MIME type mapping |

## Troubleshooting

### No provider available

If you see "No search provider available":

1. Run `/unipi:web-settings`
2. Add API keys for paid providers (they auto-enable on key input)
3. Or manually enable a free provider

### Smart-fetch fails

If smart-fetch fails to extract content:

1. Try a different browser profile: `browser: "chrome_133"`
2. Try a provider fallback: `source: 1` (Jina Reader)
3. Check if the site requires JavaScript execution (not supported)

### API key invalid

If API key validation fails:

1. Check the key is correct
2. Verify the key has sufficient permissions
3. Check provider status at their website

### Rate limiting

If you hit rate limits:

1. Add an API key for higher limits
2. Use the smart-fetch engine (default, no limits)
3. Use a different provider
4. Wait and retry

## Development

```bash
# Type check
npx tsc --noEmit

# Build
npm run build
```

## License

MIT
