/**
 * @unipi/web-api — Jina AI Search provider
 *
 * Freemium search provider using Jina AI Search API.
 * Free tier available, higher rate limits with API key.
 */

import type {
  WebProvider,
  SearchResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** Jina AI Search API response format */
interface JinaSearchResponse {
  data: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

/**
 * Search via Jina AI.
 * @param query - Search query
 * @param apiKey - Optional API key for higher rate limits
 * @returns Array of search results
 */
async function searchJina(query: string, apiKey?: string): Promise<SearchResult[]> {
  const url = `https://s.jina.ai/${encodeURIComponent(query)}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Jina AI search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as JinaSearchResponse;

  return (data.data || []).map((item) => ({
    title: item.title,
    url: item.url,
    snippet: item.snippet,
  }));
}

/** Jina AI Search provider implementation */
const jinaSearchProvider: WebProvider = {
  id: "jina-search",
  name: "Jina AI Search",
  capabilities: ["search"],
  requiresApiKey: false,
  apiKeyEnv: "JINA_API_KEY",
  ranking: {
    search: 2,
    read: 0,
    summarize: 0,
  },
  config: {},

  async search(query: string, config?: ProviderConfig): Promise<SearchResult[]> {
    const apiKey = config?.apiKey || process.env.JINA_API_KEY;
    return searchJina(query, apiKey);
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const results = await searchJina("test", apiKey);
      return Array.isArray(results);
    } catch {
      return false;
    }
  },
};

// Register provider
registry.register(jinaSearchProvider);

export { jinaSearchProvider };
