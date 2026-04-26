/**
 * @unipi/web-api — LLM Summarize provider
 *
 * Summarization provider using pi's existing LLM.
 * No external API key required - uses the LLM already configured in pi.
 */

import type {
  WebProvider,
  SummarizeResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** Default summarization prompt */
const DEFAULT_SUMMARY_PROMPT = `Summarize the following web content concisely, highlighting the key points.
Focus on:
1. Main topic and purpose
2. Key facts and findings
3. Important conclusions or recommendations

Provide a clear, well-structured summary.`;

/**
 * Summarize content using LLM.
 * This provider delegates to pi's built-in LLM for summarization.
 * The actual LLM call happens in the tool execution, not here.
 */
function createLLMSummarizeResult(
  url: string,
  content: string,
  prompt?: string
): SummarizeResult {
  // Return a placeholder - actual LLM call happens in tool execution
  return {
    url: url,
    summary: `[LLM Summary placeholder for ${url}]`,
    prompt: prompt || DEFAULT_SUMMARY_PROMPT,
  };
}

/** LLM Summarize provider implementation */
const llmSummarizeProvider: WebProvider = {
  id: "llm-summarize",
  name: "LLM Summarize",
  capabilities: ["summarize"],
  requiresApiKey: false,
  ranking: {
    search: 0,
    read: 0,
    summarize: 2,
  },
  config: {
    defaultPrompt: DEFAULT_SUMMARY_PROMPT,
  },

  async summarize(url: string, prompt?: string, _config?: ProviderConfig): Promise<SummarizeResult> {
    // This is a placeholder - actual implementation will be in the tool
    // The tool will:
    // 1. Fetch content using a read provider
    // 2. Send to LLM with the prompt
    // 3. Return the LLM's summary

    return createLLMSummarizeResult(url, "", prompt);
  },
};

// Register provider
registry.register(llmSummarizeProvider);

export { llmSummarizeProvider, DEFAULT_SUMMARY_PROMPT };
