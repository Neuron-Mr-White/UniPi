/**
 * @unipi/web-api — Perplexity provider
 *
 * Paid search and summarization provider using Perplexity API.
 * Supports search, read, and summarize capabilities.
 * Requires API key (PERPLEXITY_API_KEY environment variable).
 */

import type {
  WebProvider,
  SearchResult,
  ReadResult,
  SummarizeResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** Perplexity API response format */
interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
    citations?: Array<{
      url: string;
    }>;
  }>;
}

/**
 * Search via Perplexity.
 * @param query - Search query
 * @param apiKey - Perplexity API key
 * @returns Array of search results
 */
async function searchPerplexity(query: string, apiKey: string): Promise<SearchResult[]> {
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-sonar-small-128k-online",
      messages: [
        {
          role: "system",
          content: "You are a search assistant. Return search results as a JSON array with objects containing 'title', 'url', and 'snippet' fields.",
        },
        {
          role: "user",
          content: query,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Perplexity search failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as PerplexityResponse;
  const content = data.choices[0]?.message?.content || "[]";

  try {
    // Parse JSON from response
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Fall back to extracting from text
  }

  // Fallback: create single result from response
  const citations = data.choices[0]?.citations || [];
  return citations.map((citation, i) => ({
    title: `Result ${i + 1}`,
    url: citation.url,
    snippet: content.substring(0, 200),
  }));
}

/**
 * Summarize via Perplexity.
 * @param url - URL to summarize
 * @param prompt - Custom prompt
 * @param apiKey - Perplexity API key
 * @returns Summarized content
 */
async function summarizePerplexity(
  url: string,
  prompt: string | undefined,
  apiKey: string
): Promise<SummarizeResult> {
  const systemPrompt = prompt || "Summarize the content of this URL concisely, highlighting key points.";

  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-sonar-small-128k-online",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: `Summarize this URL: ${url}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Perplexity summarize failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as PerplexityResponse;
  const summary = data.choices[0]?.message?.content || "";

  return {
    url: url,
    summary: summary,
    prompt: prompt,
  };
}

/** Perplexity provider implementation */
const perplexityProvider: WebProvider = {
  id: "perplexity",
  name: "Perplexity",
  capabilities: ["search", "read", "summarize"],
  requiresApiKey: true,
  apiKeyEnv: "PERPLEXITY_API_KEY",
  ranking: {
    search: 5,
    read: 3,
    summarize: 1,
  },
  config: {},

  async search(query: string, config?: ProviderConfig): Promise<SearchResult[]> {
    const apiKey = config?.apiKey || process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error("Perplexity requires an API key. Set PERPLEXITY_API_KEY environment variable or configure via /unipi:web-settings");
    }
    return searchPerplexity(query, apiKey);
  },

  async read(url: string, config?: ProviderConfig): Promise<ReadResult> {
    const apiKey = config?.apiKey || process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error("Perplexity requires an API key. Set PERPLEXITY_API_KEY environment variable or configure via /unipi:web-settings");
    }

    const result = await summarizePerplexity(url, "Extract and return the full content of this URL as markdown.", apiKey);

    return {
      url: url,
      content: result.summary,
      contentType: "markdown",
    };
  },

  async summarize(url: string, prompt?: string, config?: ProviderConfig): Promise<SummarizeResult> {
    const apiKey = config?.apiKey || process.env.PERPLEXITY_API_KEY;
    if (!apiKey) {
      throw new Error("Perplexity requires an API key. Set PERPLEXITY_API_KEY environment variable or configure via /unipi:web-settings");
    }
    return summarizePerplexity(url, prompt, apiKey);
  },

  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      await searchPerplexity("test", apiKey);
      return true;
    } catch {
      return false;
    }
  },
};

// Register provider
registry.register(perplexityProvider);

export { perplexityProvider };
