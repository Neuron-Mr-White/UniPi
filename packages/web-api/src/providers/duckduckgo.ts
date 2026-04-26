/**
 * @unipi/web-api — DuckDuckGo provider
 *
 * Free search provider using DuckDuckGo.
 * Uses DuckDuckGo's HTML search endpoint for results.
 */

import type {
  WebProvider,
  SearchResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** DuckDuckGo search result parsing */
interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse DuckDuckGo HTML search results.
 * Extracts result titles, URLs, and snippets from the HTML.
 */
function parseDDGResults(html: string): DDGResult[] {
  const results: DDGResult[] = [];

  // Match result links and snippets
  // DuckDuckGo results are in <a class="result__a"> tags
  const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
  const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/g;

  const links: { url: string; title: string }[] = [];
  const snippets: string[] = [];

  let match;

  // Extract links
  while ((match = linkRegex.exec(html)) !== null) {
    links.push({
      url: match[1],
      title: match[2].trim(),
    });
  }

  // Extract snippets
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(match[1].trim());
  }

  // Combine results
  for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i],
    });
  }

  return results;
}

/**
 * Search DuckDuckGo.
 * @param query - Search query
 * @returns Array of search results
 */
async function searchDDG(query: string): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const results = parseDDGResults(html);

  return results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));
}

/** DuckDuckGo provider implementation */
const duckduckgoProvider: WebProvider = {
  id: "duckduckgo",
  name: "DuckDuckGo",
  capabilities: ["search"],
  requiresApiKey: false,
  ranking: {
    search: 1,
    read: 0,
    summarize: 0,
  },
  config: {},

  async search(query: string, _config?: ProviderConfig): Promise<SearchResult[]> {
    return searchDDG(query);
  },
};

// Register provider
registry.register(duckduckgoProvider);

export { duckduckgoProvider };
