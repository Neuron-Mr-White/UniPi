---
name: web
description: "Web search, read, and summarize tools with provider-based backend"
---

# Web Tools

Use these tools to access web content. The read path uses a local smart-fetch engine by default — free, fast, and no API key required.

## web_search

Search the web for information. Lower `source` = simpler/cheaper providers.

- **Quick facts:** source 1-2 (DuckDuckGo, Jina Search)
- **Research:** source 3-5 (SerpAPI, Tavily, Perplexity)

**Parameters:**
- `query` (required): Search query string
- `source` (optional): Provider selection (1-5)

**Examples:**
```
web_search(query: "TypeScript generics tutorial")
web_search(query: "latest AI research", source: 4)  # Use Tavily
```

## multi_web_content_read

Read and extract content from URLs. Uses the **smart-fetch engine** by default (source=0 or omitted) — free, local, no API key required. Supports single URL or batch URLs.

**Default behavior (source=0):**
- Browser-grade TLS fingerprinting via wreq-js
- Intelligent content extraction via defuddle
- Returns clean markdown with metadata (title, author, site, word count)
- No API key required

**Parameters:**
- `url` (required): Single URL string or array of URLs for batch
- `source` (optional): Provider selection (0=smart-fetch, 1=Jina Reader, 2=Firecrawl, 3=Perplexity)
- `browser` (optional): TLS fingerprint profile (default: chrome_145)
- `os` (optional): OS fingerprint (default: windows)
- `format` (optional): Output format — markdown, html, text, json (default: markdown)
- `maxChars` (optional): Maximum content characters (default: 50000)
- `timeoutMs` (optional): Request timeout in ms (default: 15000)
- `removeImages` (optional): Strip image references (default: false)
- `includeReplies` (optional): Include comments/replies (default: extractors)
- `proxy` (optional): Proxy URL
- `batchConcurrency` (optional): Concurrent requests for batch (default: 8)
- `verbose` (optional): Include metadata header (default: true)

**Examples:**
```
# Single URL (uses smart-fetch engine by default)
multi_web_content_read(url: "https://example.com/article")

# Batch URLs
multi_web_content_read(url: ["https://example.com/a", "https://example.com/b"])

# Use provider fallback (Jina Reader)
multi_web_content_read(url: "https://example.com/article", source: 1)

# Custom options
multi_web_content_read(url: "https://example.com/article", format: "json", maxChars: 10000)
```

## web_llm_summarize

Summarize URL with LLM. Higher cost (LLM tokens + provider).

- Use for complex content that needs analysis
- Custom prompts supported for targeted summaries

**Parameters:**
- `url` (required): URL to summarize
- `prompt` (optional): Custom summarization prompt
- `source` (optional): Provider selection for content fetch (1-3)

**Examples:**
```
web_llm_summarize(url: "https://example.com/long-article")
web_llm_summarize(url: "https://example.com/research", prompt: "Extract key findings")
```

## Provider Selection

- Omit `source` for auto-selection (smart-fetch engine for read, cheapest for search)
- Specify `source` number for specific provider
- If provider unavailable, tool throws descriptive error

### Provider Rankings

**Search providers:**
1. DuckDuckGo (free)
2. Jina AI Search (freemium)
3. SerpAPI (paid)
4. Tavily (paid)
5. Perplexity (paid)

**Read providers:**
0. **Smart-Fetch Engine** (free, local) — default
1. Jina AI Reader (freemium)
2. Firecrawl (paid)
3. Perplexity (paid)

**Summarize providers:**
1. Perplexity (paid)
2. LLM Summarize (uses pi's LLM)

## Smart-Fetch Engine

The smart-fetch engine is a local content extraction pipeline:

- **wreq-js**: Browser-grade TLS fingerprinting (bypasses Cloudflare, etc.)
- **defuddle**: Intelligent content extraction from HTML
- **linkedom**: Server-side DOM parsing

**Features:**
- No API key required
- Browser-level anti-bot bypass
- Clean markdown output with metadata
- Batch concurrent fetching with progress
- Client-side meta redirect following
- Multiple output formats

**Configure defaults** via `/unipi:web-settings` → "Smart Fetch Defaults"

## Cost Awareness

- **Smart-Fetch Engine:** Free (read only, no API key)
- **DuckDuckGo:** Free (search only)
- **Jina:** Freemium (search + read)
- **SerpAPI/Tavily:** Paid (search)
- **Firecrawl:** Paid (read)
- **Perplexity:** Paid (search + summarize)
- **LLM Summarize:** LLM token cost

## Configuration

Configure providers via `/unipi:web-settings` command.

- Add/remove API keys
- Enable/disable providers
- Configure smart-fetch defaults
- View provider status

## Cache

Web content is cached for 1 hour by default.

- Clear cache: `/unipi:web-cache-clear`
- Cache includes smart-fetch results (keyed by URL + browser + format + maxChars)
