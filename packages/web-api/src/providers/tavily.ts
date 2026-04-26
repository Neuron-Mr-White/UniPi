/**
 * @unipi/web-api — Tavily provider
 *
 * Paid search provider using Tavily API for AI-optimized search results.
 * Requires API key (TAVILY_API_KEY environment variable).
 */

import type {
  WebProvider,
  SearchResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** Tavily API response format */
interface TavilyResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
}

/**
 * Search via Tavily.
 * @param query - Search query
 * @param apiKey - Tavily API key
 * @returns Array of search results
 */
async function searchTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = "https://api.tavily.com/search";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as TavilyResponse;

  return (data.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.content,
  }));
}

/** Tavily provider implementation */
const tavilyProvider: WebProvider = {
  id: "tavily",
  name: "Tavily",
  capabilities: ["search"],
  requiresApiKey: true,
  apiKeyEnv: "TAVILY_API_KEY",
  ranking: {
    search: 4,
    read: 0,
    summarize: 0,
  },
  config: {},

  async search(query: string, config?: ProviderConfig): Promise<SearchResult[]> {
    const apiKey = config?.apiKey || process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error("Tavily requires an API key. Set TAVILY_API_KEY environment variable or configure via /unipi:web-settings");
    }
    return searchTavily(query, apiKey);
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const results = await searchTavily("test", apiKey);
      return Array.isArray(results);
    } catch {
      return false;
    }
  },
};

// Register provider
registry.register(tavilyProvider);

export { tavilyProvider };
