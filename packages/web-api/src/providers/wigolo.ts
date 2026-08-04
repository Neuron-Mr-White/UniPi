/**
 * @unipi/web-api — wigolo provider
 *
 * Local-first search and fetch via the wigolo engine. No API key, no cloud,
 * $0 per query — results are produced by 18 direct search-engine adapters with
 * rank fusion and on-device reranking, and pages are fetched through a tiered
 * router that escalates to a headless browser on anti-bot challenges.
 *
 * Ranked 1 for both search and read: it is the preferred default when
 * available. When wigolo is not installed or not initialized, the calls throw
 * a {@link WigoloUnavailableError} and auto-selection falls through to the
 * next-ranked provider (see `selectProvider` in ../tools.ts).
 */

import type { WebProvider, SearchResult, ReadResult, ProviderConfig } from "./base.js";
import { registry } from "./registry.js";
import { getWigoloClient } from "./wigolo-client.js";

/** Default number of results requested from wigolo. */
const DEFAULT_MAX_RESULTS = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Normalize one wigolo search result.
 *
 * The REST contract types `results` as `unknown[]` because the shape is
 * extensible, so every field is read defensively. wigolo returns an `excerpt`
 * pinned to a byte-exact source span; older/alternate builds use `snippet` or
 * `content`.
 */
function toSearchResult(raw: unknown): SearchResult | null {
  if (!isRecord(raw)) return null;

  const url = readString(raw.url);
  if (!url) return null;

  const snippet =
    readString(raw.excerpt) ||
    readString(raw.snippet) ||
    readString(raw.content) ||
    readString(raw.description);

  return {
    title: readString(raw.title) || url,
    url,
    snippet,
  };
}

/** Surface an in-body error field — a 200 response can still carry one. */
function assertNoBodyError(body: { error?: string }, action: string): void {
  if (body?.error) {
    throw new Error(`wigolo ${action} failed: ${body.error}`);
  }
}

const wigoloProvider: WebProvider = {
  id: "wigolo",
  name: "wigolo (local)",
  capabilities: ["search", "read"],
  requiresApiKey: false,
  ranking: {
    search: 1,
    read: 1,
    summarize: 0,
  },
  config: {},

  async search(query: string, config?: ProviderConfig): Promise<SearchResult[]> {
    const client = await getWigoloClient();

    const maxResults =
      typeof config?.maxResults === "number" ? config.maxResults : DEFAULT_MAX_RESULTS;

    const response = await client.search({
      query,
      max_results: maxResults,
    });

    assertNoBodyError(response, "search");

    const results = Array.isArray(response.results) ? response.results : [];
    return results
      .map(toSearchResult)
      .filter((result): result is SearchResult => result !== null);
  },

  async read(url: string, _config?: ProviderConfig): Promise<ReadResult> {
    const client = await getWigoloClient();

    const response = await client.fetch({ url });

    assertNoBodyError(response, "fetch");

    const content = readString(response.markdown);
    if (!content) {
      throw new Error(`wigolo returned no content for ${url}`);
    }

    return {
      url: readString(response.url) || url,
      content,
      contentType: "markdown",
    };
  },
};

registry.register(wigoloProvider);

export { wigoloProvider };
