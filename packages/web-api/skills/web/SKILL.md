---
name: web
description: "Web search, read, and summarize tools with provider-based backend"
---

# Web Tools

Use these tools to access web content. Providers are ranked by capability and cost.

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

## web_read

Read URL content. Lower `source` = simpler providers.

- **Basic extraction:** source 1 (Jina Reader)
- **Advanced crawling:** source 2 (Firecrawl)

**Parameters:**
- `url` (required): URL to read
- `source` (optional): Provider selection (1-3)

**Examples:**
```
web_read(url: "https://example.com/article")
web_read(url: "https://example.com/spa", source: 2)  # Use Firecrawl
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

- Omit `source` for auto-selection (cheapest available)
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
1. Jina AI Reader (freemium)
2. Firecrawl (paid)
3. Perplexity (paid)

**Summarize providers:**
1. Perplexity (paid)
2. LLM Summarize (uses pi's LLM)

## Cost Awareness

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
- View provider status

## Cache

Web content is cached for 1 hour by default.

- Clear cache: `/unipi:web-cache-clear`
- Cache is automatic for web_read operations
