# @pi-unipi/web-api

Web search, page reading, and content summarization for the agent. The read path uses a local smart-fetch engine by default — free, no API key, browser-grade TLS fingerprinting that bypasses Cloudflare.

Paid providers (SerpAPI, Tavily, Firecrawl, Perplexity) are available as fallbacks. DuckDuckGo and Jina work out of the box for search.

## Commands

| Command | Description |
|---------|-------------|
| `/unipi:web-settings` | Configure providers, API keys, and smart-fetch defaults |
| `/unipi:web-cache-clear` | Clear all cached web content |

## Special Triggers

Workflow skills detect web-api and inject web tools for research-type commands:

| Skill | What Changes |
|-------|--------------|
| `research` | Full web search, read, summarize |
| `gather-context` | External documentation lookup |
| `consultant` | Industry best practices research |
| `subagents` (explore) | Web research in parallel |

The footer and info-screen don't display web-api data — it's a tool package, not a state package.

## Agent Tools

| Tool | Description |
|------|-------------|
| `web_search` | Search the web via provider |
| `multi_web_content_read` | Extract content from URLs (smart-fetch or provider) |
| `web_llm_summarize` | Summarize web content via LLM |

### web_search

```
# Auto-select cheapest provider
web_search(query: "TypeScript generics")

# Use specific provider
web_search(query: "latest AI research", source: 4)  # Tavily
```

### multi_web_content_read

```
# Single URL (smart-fetch engine by default)
multi_web_content_read(url: "https://example.com/article")

# Batch URLs
multi_web_content_read(url: ["https://example.com/a", "https://example.com/b"])

# Provider fallback (Jina Reader)
multi_web_content_read(url: "https://example.com/article", source: 1)

# Custom options
multi_web_content_read(url: "https://example.com/article", format: "json", maxChars: 10000)
```

### web_llm_summarize

```
web_llm_summarize(url: "https://example.com/long-article")
web_llm_summarize(url: "https://example.com/research", prompt: "Extract key findings")
```

## Smart-Fetch Engine

Local content extraction pipeline — no API key required:

| Component | Purpose |
|-----------|---------|
| **wreq-js** | Browser-grade TLS fingerprinting (bypasses Cloudflare) |
| **defuddle** | Intelligent content extraction from HTML |
| **linkedom** | Server-side DOM parsing |

Outputs clean markdown with metadata (title, author, site, word count). Supports batch concurrent fetching with progress.

## Providers

### Search

| Provider | Rank | Cost | API Key |
|----------|------|------|---------|
| DuckDuckGo | 1 | Free | No |
| Jina AI Search | 2 | Freemium | Optional |
| SerpAPI | 3 | Paid | Required |
| Tavily | 4 | Paid | Required |
| Perplexity | 5 | Paid | Required |

### Read

| Provider | Rank | Cost | API Key |
|----------|------|------|---------|
| Smart-Fetch Engine | 0 | Free | No |
| Jina AI Reader | 1 | Freemium | Optional |
| Firecrawl | 2 | Paid | Required |
| Perplexity | 3 | Paid | Required |

### Summarize

| Provider | Rank | Cost | API Key |
|----------|------|------|---------|
| Perplexity | 1 | Paid | Required |
| LLM Summarize | 2 | LLM tokens | No |

## Configurables

### API Keys

Configure via `/unipi:web-settings` (interactive TUI) or environment variables:

```bash
export SERPAPI_KEY="your-key"
export TAVILY_API_KEY="your-key"
export FIRECRAWL_API_KEY="your-key"
export PERPLEXITY_API_KEY="your-key"
export JINA_API_KEY="your-key"
```

Providers auto-enable when you add a valid API key.

### Smart-Fetch Defaults

Configure browser profile, OS, max chars, timeout via `/unipi:web-settings → "Smart Fetch Defaults"`.

### Settings Files

- **Auth:** `~/.unipi/config/web-api/auth.json` (API keys, gitignored)
- **Config:** `~/.unipi/config/web-api/config.json` (provider settings, smart-fetch defaults)

### Cache

- Default TTL: 1 hour
- Cache location: `~/.unipi/config/web-api/cache/`
- Automatic for all read operations

## Troubleshooting

**No provider available:** Run `/unipi:web-settings` and add API keys or enable a free provider.

**Smart-fetch fails:** Try a different browser profile (`browser: "chrome_133"`) or a provider fallback (`source: 1`).

**Rate limiting:** Add an API key for higher limits, use smart-fetch (no limits), or try a different provider.

## License

MIT
