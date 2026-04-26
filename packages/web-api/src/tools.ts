/**
 * @unipi/web-api — Agent tools registration
 *
 * Registers web-search, web-read, and web-llm-summarize tools.
 * Implements smart provider selection based on ranking.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registry } from "./providers/registry.js";
import type {
  WebProvider,
  WebCapability,
  SearchResult,
  ReadResult,
  SummarizeResult,
} from "./providers/base.js";
import {
  getApiKey,
  isProviderEnabled,
  loadConfig,
} from "./settings.js";

/** Tool names */
export const WEB_TOOLS = {
  SEARCH: "web_search",
  READ: "web_read",
  SUMMARIZE: "web_llm_summarize",
} as const;

/**
 * Get available providers for a capability.
 * Filters by enabled status and API key availability.
 */
function getAvailableProviders(capability: WebCapability): WebProvider[] {
  const config = loadConfig();
  const ranked = registry.getRankedProviders(capability);

  return ranked.filter((provider) => {
    // Check if provider is enabled
    if (!isProviderEnabled(provider.id)) {
      return false;
    }

    // Check if provider requires API key
    if (provider.requiresApiKey) {
      const apiKey = getApiKey(provider.id);
      if (!apiKey) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Select provider for a capability.
 * If sourceRank is specified, use that rank.
 * Otherwise, use the lowest-ranked available provider.
 */
function selectProvider(
  capability: WebCapability,
  sourceRank?: number
): WebProvider {
  const available = getAvailableProviders(capability);

  if (available.length === 0) {
    const allProviders = registry.getProvidersForCapability(capability);
    const providerNames = allProviders.map((p) => p.name).join(", ");
    throw new Error(
      `No ${capability} provider available.\n` +
      `Configure providers via /unipi:web-settings\n` +
      `Available providers: ${providerNames}`
    );
  }

  if (sourceRank !== undefined) {
    // Find provider with matching rank
    const provider = available.find((p) => p.ranking[capability] === sourceRank);
    if (!provider) {
      const availableRanks = available.map((p) => p.ranking[capability]).join(", ");
      throw new Error(
        `No provider at rank ${sourceRank} for ${capability}.\n` +
        `Available ranks: ${availableRanks}`
      );
    }
    return provider;
  }

  // Return lowest-ranked (cheapest/simplest) available provider
  return available[0];
}

/**
 * Execute web search.
 */
async function executeSearch(
  query: string,
  sourceRank?: number
): Promise<SearchResult[]> {
  const provider = selectProvider("search", sourceRank);

  if (!provider.search) {
    throw new Error(`Provider "${provider.name}" does not support search`);
  }

  const apiKey = provider.requiresApiKey ? getApiKey(provider.id) : undefined;
  const config = { enabled: true, apiKey };

  return provider.search(query, config);
}

/**
 * Execute web read.
 */
async function executeRead(
  url: string,
  sourceRank?: number
): Promise<ReadResult> {
  const provider = selectProvider("read", sourceRank);

  if (!provider.read) {
    throw new Error(`Provider "${provider.name}" does not support read`);
  }

  const apiKey = provider.requiresApiKey ? getApiKey(provider.id) : undefined;
  const config = { enabled: true, apiKey };

  return provider.read(url, config);
}

/**
 * Execute web summarize.
 */
async function executeSummarize(
  url: string,
  prompt?: string,
  sourceRank?: number
): Promise<SummarizeResult> {
  const provider = selectProvider("summarize", sourceRank);

  if (!provider.summarize) {
    throw new Error(`Provider "${provider.name}" does not support summarize`);
  }

  const apiKey = provider.requiresApiKey ? getApiKey(provider.id) : undefined;
  const config = { enabled: true, apiKey };

  return provider.summarize(url, prompt, config);
}

/**
 * Register web tools with pi.
 */
export function registerWebTools(pi: ExtensionAPI): void {
  // --- web_search tool ---
  pi.registerTool({
    name: WEB_TOOLS.SEARCH,
    label: "Web Search",
    description:
      "Search the web for information using various providers. " +
      "Lower source = simpler/cheaper providers (DuckDuckGo, Jina Search). " +
      "Higher source = more capable providers (SerpAPI, Tavily, Perplexity).",
    promptSnippet: "Search the web for information.",
    promptGuidelines: [
      "Use web_search to find information on the web.",
      "Omit source for auto-selection (cheapest available).",
      "Specify source number for specific provider (1=DuckDuckGo, 2=Jina, 3=SerpAPI, 4=Tavily, 5=Perplexity).",
      "Quick facts: source 1-2. Research: source 3-5.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      source: Type.Optional(
        Type.Number({
          description:
            "Provider selection (1=DuckDuckGo, 2=Jina Search, 3=SerpAPI, 4=Tavily, 5=Perplexity). " +
            "Omit for auto-selection.",
          minimum: 1,
          maximum: 5,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const results = await executeSearch(params.query, params.source);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No results found." }],
          };
        }

        const formatted = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: `Found ${results.length} results:\n\n${formatted}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Search failed: ${message}` }],
          isError: true,
        };
      }
    },
  });

  // --- web_read tool ---
  pi.registerTool({
    name: WEB_TOOLS.READ,
    label: "Web Read",
    description:
      "Read and extract content from a URL. " +
      "Extracts main content, strips navigation/ads. Returns markdown.",
    promptSnippet: "Read content from a URL.",
    promptGuidelines: [
      "Use web_read to extract content from a web page.",
      "Returns main content as markdown.",
      "Lower source = simpler providers (Jina Reader).",
      "Higher source = more capable providers (Firecrawl, Perplexity).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to read" }),
      source: Type.Optional(
        Type.Number({
          description:
            "Provider selection (1=Jina Reader, 2=Firecrawl, 3=Perplexity). " +
            "Omit for auto-selection.",
          minimum: 1,
          maximum: 3,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await executeRead(params.url, params.source);

        return {
          content: [
            {
              type: "text",
              text: `Content from ${result.url}:\n\n${result.content}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Read failed: ${message}` }],
          isError: true,
        };
      }
    },
  });

  // --- web_llm_summarize tool ---
  pi.registerTool({
    name: WEB_TOOLS.SUMMARIZE,
    label: "Web LLM Summarize",
    description:
      "Summarize web content using LLM. " +
      "Fetches content from URL, then uses LLM to summarize. " +
      "Higher cost (LLM tokens + provider cost).",
    promptSnippet: "Summarize web content using LLM.",
    promptGuidelines: [
      "Use web_llm_summarize to get a summary of web content.",
      "Specify custom prompt for targeted summaries.",
      "Omit source for auto-selection of content provider.",
      "Higher cost due to LLM token usage.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to summarize" }),
      prompt: Type.Optional(
        Type.String({
          description:
            "Custom summarization prompt. " +
            "Omit for default comprehensive summary.",
        })
      ),
      source: Type.Optional(
        Type.Number({
          description:
            "Provider selection for content fetch (1=Jina Reader, 2=Firecrawl, 3=Perplexity). " +
            "Omit for auto-selection.",
          minimum: 1,
          maximum: 3,
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const result = await executeSummarize(
          params.url,
          params.prompt,
          params.source
        );

        return {
          content: [
            {
              type: "text",
              text: `Summary of ${result.url}:\n\n${result.summary}`,
            },
          ],
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Summarize failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
