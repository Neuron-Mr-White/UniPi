/**
 * @unipi/web-api — SerpAPI provider
 *
 * Paid search provider using SerpAPI for Google search results.
 * Requires API key (SERPAPI_KEY environment variable).
 */

import type {
  WebProvider,
  SearchResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** SerpAPI response format */
interface SerpAPIResponse {
  organic_results: Array<{
    title: string;
    link: string;
    snippet: string;
  }>;
}

/**
 * Search via SerpAPI.
 * @param query - Search query
 * @param apiKey - SerpAPI key
 * @returns Array of search results
 */
async function searchSerpAPI(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = new URL("https://serpapi.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("engine", "google");

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`SerpAPI search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SerpAPIResponse;

  return (data.organic_results || []).map((item) => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
  }));
}

/** SerpAPI provider implementation */
const serpapiProvider: WebProvider = {
  id: "serpapi",
  name: "SerpAPI",
  capabilities: ["search"],
  requiresApiKey: true,
  apiKeyEnv: "SERPAPI_KEY",
  ranking: {
    search: 3,
    read: 0,
    summarize: 0,
  },
  config: {},

  async search(query: string, config?: ProviderConfig): Promise<SearchResult[]> {
    const apiKey = config?.apiKey || process.env.SERPAPI_KEY;
    if (!apiKey) {
      throw new Error("SerpAPI requires an API key. Set SERPAPI_KEY environment variable or configure via /unipi:web-settings");
    }
    return searchSerpAPI(query, apiKey);
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const results = await searchSerpAPI("test", apiKey);
      return Array.isArray(results);
    } catch {
      return false;
    }
  },
};

// Register provider
registry.register(serpapiProvider);

export { serpapiProvider };
