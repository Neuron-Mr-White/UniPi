/**
 * @unipi/web-api — Provider base interface
 *
 * Defines the WebProvider interface and capability types for all providers.
 */

/** Supported capabilities for web providers */
export type WebCapability = "search" | "read" | "summarize";

/** Ranking structure for provider selection */
export interface ProviderRanking {
  search: number;
  read: number;
  summarize: number;
}

/** Search result format */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Read result format */
export interface ReadResult {
  url: string;
  content: string;
  contentType: "markdown" | "text" | "html";
}

/** Summarize result format */
export interface SummarizeResult {
  url: string;
  summary: string;
  prompt?: string;
}

/** Provider configuration */
export interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  [key: string]: unknown;
}

/**
 * WebProvider interface
 *
 * All web providers must implement this interface.
 * Providers declare their capabilities and ranking for each capability.
 */
export interface WebProvider {
  /** Unique provider identifier */
  id: string;

  /** Human-readable provider name */
  name: string;

  /** Capabilities this provider supports */
  capabilities: WebCapability[];

  /** Whether this provider requires an API key */
  requiresApiKey: boolean;

  /** Environment variable name for API key (if requiresApiKey) */
  apiKeyEnv?: string;

  /**
   * Ranking for capability selection.
   * Lower number = simpler/cheaper provider (preferred for auto-selection).
   * 0 means provider doesn't support that capability.
   */
  ranking: ProviderRanking;

  /** Provider-specific configuration */
  config: Record<string, unknown>;

  /**
   * Search the web.
   * @param query - Search query string
   * @param config - Provider-specific configuration
   * @returns Array of search results
   */
  search?(query: string, config?: ProviderConfig): Promise<SearchResult[]>;

  /**
   * Read and extract content from a URL.
   * @param url - URL to read
   * @param config - Provider-specific configuration
   * @returns Extracted content
   */
  read?(url: string, config?: ProviderConfig): Promise<ReadResult>;

  /**
   * Summarize web content.
   * @param url - URL to summarize
   * @param prompt - Custom summarization prompt
   * @param config - Provider-specific configuration
   * @returns Summarized content
   */
  summarize?(url: string, prompt?: string, config?: ProviderConfig): Promise<SummarizeResult>;

  /**
   * Validate API key (optional).
   * @param apiKey - API key to validate
   * @returns true if valid
   */
  validateApiKey?(apiKey: string): Promise<boolean>;
}
