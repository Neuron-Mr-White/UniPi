# Web API

Give the agent tools to search the web and read pages, with free providers first.

`@pi-unipi/web-api` · part of [UniPi](../../README.md)

## What it does

- Adds three agent tools: `web_search`, `multi_web_content_read` and `web_llm_summarize`.
- Reads pages with a local smart-fetch engine by default. This engine needs no API key and costs $0.
- Sorts providers by rank. Free providers have the lowest ranks.
- Tries the next provider when one provider fails, if you do not name a provider.
- Keeps read results in a file cache for 1 hour.
- Uses [wigolo](https://github.com/KnockOutEZ/wigolo) for search and read when you install it. wigolo is a local search engine. It needs no API key.

## Quick start

UniPi installs this package:

```bash
pi install npm:@pi-unipi/unipi
```

To install this package alone:

```bash
pi install npm:@pi-unipi/web-api
```

The tools work with no setup. DuckDuckGo, Jina and the smart-fetch engine need no key.

To add wigolo (optional, about 1.5 GB of models):

```bash
npm install -g wigolo
npx wigolo init
npx wigolo doctor
```

UniPi does not bundle wigolo, because wigolo uses the AGPL license. UniPi loads it at run time only when you install it. If wigolo is not ready, the tools use the next provider.

## Commands

This package has no slash commands. Open `/unipi:settings` and select the **Web API** group to change providers, keys and fetch defaults. The group also has a **Clear web cache…** action.

## Agent tools

| Tool | What it does |
|---|---|
| `web_search` | Searches the web. Returns a list of titles, URLs and snippets. |
| `multi_web_content_read` | Reads one URL or a list of URLs. Returns markdown with title, author, site and word count. |
| `web_llm_summarize` | Summarizes one URL. Takes an optional `prompt`. Needs Perplexity with an API key. |

Each tool takes an optional `source` number. Omit `source` to let the tool select the provider. If you give `source`, the tool uses only that provider and reports its error.

```text
web_search(query: "TypeScript generics")
web_search(query: "latest AI research", source: 5)
multi_web_content_read(url: ["https://example.com/a", "https://example.com/b"])
multi_web_content_read(url: "https://example.com/article", format: "json", maxChars: 10000)
web_llm_summarize(url: "https://example.com/research", prompt: "List the key findings")
```

`multi_web_content_read` also takes `browser`, `os`, `format` (`markdown`, `html`, `text`, `json`), `maxChars`, `timeoutMs`, `removeImages`, `includeReplies`, `proxy`, `batchConcurrency` and `verbose`.

## Providers

| `source` | `web_search` | `multi_web_content_read` | `web_llm_summarize` | Key |
|---|---|---|---|---|
| 0 | — | smart-fetch engine (default) | — | No |
| 1 | wigolo | wigolo | Perplexity | No (Perplexity: yes) |
| 2 | DuckDuckGo | Jina Reader | — | No |
| 3 | Jina Search | Firecrawl | — | Jina: optional. Firecrawl: yes |
| 4 | SerpAPI | Perplexity | — | Yes |
| 5 | Tavily | — | — | Yes |
| 6 | Perplexity | — | — | Yes |

SerpAPI, Tavily, Firecrawl and Perplexity are off by default. To use one, enable it and set its API key in `/unipi:settings` → **Web API** → **Providers**.

## Settings

Open `/unipi:settings` → **Web API**. The settings file is `~/.unipi/config/web-api/config.json`. A project file at `.unipi/config/web-api/config.json` overrides it.

| Key | Default | What it does |
|---|---|---|
| `providers.<id>.enabled` | `true` for wigolo, DuckDuckGo, Jina. `false` for paid providers | Turns a provider on or off. |
| `providers.<id>.apiKey` | unset | API key for the provider. |
| `smartFetch.browser` | `chrome_145` | TLS fingerprint profile of the smart-fetch engine. |
| `smartFetch.os` | `windows` | OS fingerprint. |
| `smartFetch.maxChars` | `50000` | Maximum characters in one result. |
| `smartFetch.timeoutMs` | `15000` | Request timeout in milliseconds. |
| `smartFetch.batchConcurrency` | `8` | Number of URLs that one batch read fetches at the same time. |
| `smartFetch.removeImages` | `false` | Removes image references from the result. |
| `smartFetch.includeReplies` | `extractors` | Extracts replies and comments where an extractor supports them. |

## How it works

The smart-fetch engine uses three libraries:

- `wreq-js` sends requests with a browser TLS fingerprint.
- `linkedom` parses the HTML.
- `defuddle` extracts the main content.

The tool caches smart-fetch results in `~/.unipi/config/web-api/cache/`. The cache key includes the URL, browser, format and `maxChars`. UniPi removes expired entries at session start and at session end.

The Info Screen shows a **Web API** group with the count of enabled providers, the wigolo state, the smart-fetch state and cache size.

## Troubleshooting

- **No provider configured.** Open `/unipi:settings` → **Web API**. Enable a free provider.
- **A page does not load with smart-fetch.** Set a different `browser` value, or use a provider with `source: 2`.
- **`web_llm_summarize` fails.** Enable Perplexity and set its API key.

## See also

- [Settings reference](../../docs/reference/settings.md)
- [Tools reference](../../docs/reference/tools.md)
- [Info Screen](../info-screen/README.md)
