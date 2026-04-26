/**
 * @unipi/web-api — Jina AI Reader provider
 *
 * Freemium content extraction provider using Jina AI Reader API.
 * Extracts main content from URLs and returns markdown.
 */

import type {
  WebProvider,
  ReadResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** Jina AI Reader API response format */
interface JinaReaderResponse {
  data: {
    url: string;
    content: string;
    title?: string;
    description?: string;
  };
}

/**
 * Read content from URL via Jina AI Reader.
 * @param url - URL to read
 * @param apiKey - Optional API key for higher rate limits
 * @returns Extracted content
 */
async function readJina(url: string, apiKey?: string): Promise<ReadResult> {
  const jinaUrl = `https://r.jina.ai/${url}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(jinaUrl, { headers });

  if (!response.ok) {
    throw new Error(`Jina AI Reader failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as JinaReaderResponse;

  return {
    url: data.data.url || url,
    content: data.data.content,
    contentType: "markdown",
  };
}

/** Jina AI Reader provider implementation */
const jinaReaderProvider: WebProvider = {
  id: "jina-reader",
  name: "Jina AI Reader",
  capabilities: ["read"],
  requiresApiKey: false,
  apiKeyEnv: "JINA_API_KEY",
  ranking: {
    search: 0,
    read: 1,
    summarize: 0,
  },
  config: {},

  async read(url: string, config?: ProviderConfig): Promise<ReadResult> {
    const apiKey = config?.apiKey || process.env.JINA_API_KEY;
    return readJina(url, apiKey);
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      await readJina("https://example.com", apiKey);
      return true;
    } catch {
      return false;
    }
  },
};

// Register provider
registry.register(jinaReaderProvider);

export { jinaReaderProvider };
