/**
 * @unipi/web-api — DuckDuckGo provider
 *
 * Free search provider using DuckDuckGo.
 * Uses DuckDuckGo's HTML search endpoint for results.
 */

import type {
  WebProvider,
  SearchResult,
  ProviderConfig,
} from "./base.js";
import { registry } from "./registry.js";

/** DuckDuckGo search result parsing */
interface DDGResult {
  title: string;
  url: string;
  snippet: string;
}

/** Decode the handful of HTML entities DuckDuckGo emits. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Strip inline markup (DuckDuckGo bolds query terms with <b> inside snippets). */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/**
 * Unwrap DuckDuckGo's redirect links.
 *
 * Result hrefs look like `//duckduckgo.com/l/?uddg=<encoded>&rut=<hash>`; the
 * real destination is the `uddg` parameter. Returning the wrapper would give
 * the agent a URL that is useless to read or cite.
 */
export function unwrapRedirect(href: string): string {
  const decoded = decodeEntities(href);

  const match = decoded.match(/[?&]uddg=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      // Fall through to the protocol-relative fix below.
    }
  }

  // Protocol-relative links would otherwise be unusable.
  if (decoded.startsWith("//")) return `https:${decoded}`;

  return decoded;
}

/**
 * Parse DuckDuckGo HTML search results.
 *
 * Titles and snippets are parsed per result block rather than as two
 * independent streams: a result without a snippet used to shift every
 * subsequent snippet onto the wrong title.
 */
export function parseDDGResults(html: string): DDGResult[] {
  const results: DDGResult[] = [];

  // `[\s\S]*?` (not `.`) so blocks spanning newlines are matched.
  const linkRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  // Snippets contain <b> highlights, so the body cannot be `[^<]*`.
  const snippetRegex =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: Array<{ index: number; text: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push({
      index: match.index,
      text: decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim(),
    });
  }

  while ((match = linkRegex.exec(html)) !== null) {
    const url = unwrapRedirect(match[1]);
    const title = decodeEntities(stripTags(match[2])).replace(/\s+/g, " ").trim();
    if (!url || !title) continue;

    // The snippet belongs to this result if it appears before the next one.
    const linkEnd = match.index + match[0].length;
    const nextLink = html.indexOf('class="result__a"', linkEnd);
    const boundary = nextLink === -1 ? html.length : nextLink;
    const snippet = snippets.find((s) => s.index > match!.index && s.index < boundary);

    results.push({ title, url, snippet: snippet?.text ?? "" });
  }

  return results;
}

/**
 * Search DuckDuckGo.
 * @param query - Search query
 * @returns Array of search results
 */
async function searchDDG(query: string): Promise<SearchResult[]> {
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const results = parseDDGResults(html);

  return results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.snippet,
  }));
}

/** DuckDuckGo provider implementation */
const duckduckgoProvider: WebProvider = {
  id: "duckduckgo",
  name: "DuckDuckGo",
  capabilities: ["search"],
  requiresApiKey: false,
  ranking: {
    search: 2,
    read: 0,
    summarize: 0,
  },

  async search(query: string, _config?: ProviderConfig): Promise<SearchResult[]> {
    return searchDDG(query);
  },
};

// Register provider
registry.register(duckduckgoProvider);

export { duckduckgoProvider };
