/**
 * @unipi/web-api — Firecrawl provider
 *
 * Paid content extraction provider using Firecrawl API.
 * Advanced web scraping with JavaScript rendering support.
 * Requires API key (FIRECRAWL_API_KEY environment variable).
 */

import type {
  WebProvider,
  ReadResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** Firecrawl API response format */
interface FirecrawlResponse {
  success: boolean;
  data: {
    markdown: string;
    html?: string;
    metadata?: {
      title?: string;
      description?: string;
    };
  };
}

/**
 * Read content from URL via Firecrawl.
 * @param url - URL to read
 * @param apiKey - Firecrawl API key
 * @returns Extracted content
 */
async function readFirecrawl(url: string, apiKey: string): Promise<ReadResult> {
  const apiUrl = "https://api.firecrawl.dev/v0/scrape";

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url: url,
      pageOptions: {
        onlyMainContent: true,
        waitForSelector: "body",
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Firecrawl read failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as FirecrawlResponse;

  if (!data.success) {
    throw new Error("Firecrawl extraction failed");
  }

  return {
    url: url,
    content: data.data.markdown,
    contentType: "markdown",
  };
}

/** Firecrawl provider implementation */
const firecrawlProvider: WebProvider = {
  id: "firecrawl",
  name: "Firecrawl",
  capabilities: ["read"],
  requiresApiKey: true,
  apiKeyEnv: "FIRECRAWL_API_KEY",
  ranking: {
    search: 0,
    read: 2,
    summarize: 0,
  },
  config: {},

  async read(url: string, config?: ProviderConfig): Promise<ReadResult> {
    const apiKey = config?.apiKey || process.env.FIRECRAWL_API_KEY;
    if (!apiKey) {
      throw new Error("Firecrawl requires an API key. Set FIRECRAWL_API_KEY environment variable or configure via /unipi:web-settings");
    }
    return readFirecrawl(url, apiKey);
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      await readFirecrawl("https://example.com", apiKey);
      return true;
    } catch {
      return false;
    }
  },
};

// Register provider
registry.register(firecrawlProvider);

export { firecrawlProvider };
