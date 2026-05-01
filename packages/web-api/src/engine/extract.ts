/**
 * @unipi/web-api — Core Extraction Pipeline
 *
 * The heart of the smart-fetch engine:
 * URL validation → wreq-js fetch → content-type routing → defuddle extraction → fallbacks.
 */

import type {
  FetchResult,
  FetchError,
  FetchOptions,
  FetchProgress,
  FetchExecutionHooks,
  BatchFetchResult,
  BatchFetchItemResult,
  FetchProgressStatus,
} from "./types.js";
import {
  DEFAULT_BROWSER,
  DEFAULT_OS,
  DEFAULT_FORMAT,
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_REMOVE_IMAGES,
  DEFAULT_INCLUDE_REPLIES,
  DEFAULT_HEADERS,
  DEFAULT_BATCH_CONCURRENCY,
} from "./constants.js";
import { resolveBrowserProfile, resolveOSProfile } from "./profiles.js";
import { getWreq, getDefuddle, getMimeTypes } from "./dependencies.js";
import { parseHTML, extractTextContent, elementToMarkdown } from "./dom.js";
import { truncateContent, formatContent } from "./format.js";

/** Maximum meta refresh redirects to follow */
const MAX_REDIRECTS = 5;

/** Maximum alternate link fallbacks to try */
const MAX_ALTERNATE_LINKS = 3;

/**
 * Validate a URL for fetching.
 * Only http and https protocols are supported.
 *
 * @param url - URL to validate
 * @returns Validated URL or throws
 */
function validateUrl(url: string): URL {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw createError(
      "invalid_url",
      "validation",
      `Invalid URL format: ${url}`,
      false
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createError(
      "unsupported_protocol",
      "validation",
      `Unsupported protocol: ${parsed.protocol}. Only http and https are supported.`,
      false
    );
  }

  return parsed;
}

/**
 * Create a FetchError object.
 */
function createError(
  code: FetchError["code"],
  phase: FetchError["phase"],
  message: string,
  retryable: boolean,
  extra: Partial<FetchError> = {}
): FetchError {
  return {
    error: message,
    code,
    phase,
    retryable,
    ...extra,
  };
}

/**
 * Create a FetchResult object.
 */
function createResult(
  url: string,
  finalUrl: string,
  content: string,
  metadata: Partial<FetchResult> = {}
): FetchResult {
  return {
    url,
    finalUrl,
    title: metadata.title || "",
    author: metadata.author || "",
    published: metadata.published || "",
    site: metadata.site || "",
    language: metadata.language || "",
    wordCount: content.split(/\s+/).filter(Boolean).length,
    content,
    format: metadata.format || "markdown",
    mimeType: metadata.mimeType || "text/html",
  };
}

/**
 * Extract metadata from defuddle result.
 */
function extractMetadata(
  defuddleResult: any,
  document: Document
): Partial<FetchResult> {
  const metadata: Partial<FetchResult> = {};

  // Try defuddle-extracted metadata
  if (defuddleResult) {
    metadata.title = defuddleResult.title || "";
    metadata.author = defuddleResult.author || "";
    metadata.published = defuddleResult.published || defuddleResult.date || "";
    metadata.site = defuddleResult.site || defuddleResult.siteName || "";
    metadata.language = defuddleResult.language || "";
  }

  // Fall back to DOM extraction
  if (!metadata.title) {
    const titleEl = document.querySelector("title");
    metadata.title = titleEl?.textContent?.trim() || "";
  }

  // Try og:title
  if (!metadata.title) {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    metadata.title = ogTitle?.getAttribute("content") || "";
  }

  // Try meta author
  if (!metadata.author) {
    const authorMeta = document.querySelector('meta[name="author"]');
    metadata.author = authorMeta?.getAttribute("content") || "";
  }

  // Try meta site
  if (!metadata.site) {
    const siteMeta = document.querySelector('meta[property="og:site_name"]');
    metadata.site = siteMeta?.getAttribute("content") || "";
  }

  // Try html lang
  if (!metadata.language) {
    const htmlEl = document.querySelector("html");
    metadata.language = htmlEl?.getAttribute("lang") || "";
  }

  return metadata;
}

/**
 * Check for client-side meta refresh redirects.
 *
 * @param document - DOM document
 * @returns Redirect URL if found
 */
function findMetaRefresh(document: Document): string | null {
  const metaRefresh = document.querySelector(
    'meta[http-equiv="refresh"]'
  ) as HTMLMetaElement | null;

  if (!metaRefresh) {
    return null;
  }

  const content = metaRefresh.getAttribute("content");
  if (!content) {
    return null;
  }

  // Parse: "0;url=https://example.com" or "0; URL='https://example.com'"
  const match = content.match(/url\s*=\s*['"]?([^'"\s]+)['"]?/i);
  if (!match) {
    return null;
  }

  return match[1];
}

/**
 * Check for alternate JSON content links.
 *
 * @param document - DOM document
 * @returns Array of alternate URLs
 */
function findAlternateLinks(document: Document): string[] {
  const alternates: string[] = [];

  // Look for JSON feeds, oEmbed, etc.
  const links = document.querySelectorAll(
    'link[rel="alternate"][type="application/json"], ' +
    'link[rel="alternate"][type="application/ld+json"]'
  );

  for (const link of Array.from(links)) {
    const href = link.getAttribute("href");
    if (href) {
      alternates.push(href);
    }
  }

  return alternates.slice(0, MAX_ALTERNATE_LINKS);
}

/**
 * Detect content type from response.
 */
function detectContentType(
  response: Response,
  buffer: ArrayBuffer
): { mimeType: string; isBinary: boolean } {
  const contentType = response.headers.get("content-type") || "";
  const mimeType = contentType.split(";")[0].trim().toLowerCase();

  // Check for binary types
  const binaryTypes = [
    "application/octet-stream",
    "application/pdf",
    "application/zip",
    "application/x-",
    "image/",
    "video/",
    "audio/",
    "font/",
  ];

  const isBinary = binaryTypes.some((t) => mimeType.startsWith(t));

  return { mimeType, isBinary };
}

/**
 * The main fetch + extraction pipeline.
 *
 * @param url - URL to fetch
 * @param options - Fetch options
 * @param hooks - Execution hooks for progress
 * @returns Fetch result or throws FetchError
 */
export async function defuddleFetch(
  url: string,
  options: FetchOptions = {},
  hooks?: FetchExecutionHooks
): Promise<FetchResult> {
  const {
    browser = DEFAULT_BROWSER,
    os = DEFAULT_OS,
    format = DEFAULT_FORMAT,
    maxChars = DEFAULT_MAX_CHARS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    removeImages = DEFAULT_REMOVE_IMAGES,
    includeReplies = DEFAULT_INCLUDE_REPLIES,
    proxy,
    headers: customHeaders,
  } = options;

  // Track progress
  const updateProgress = (
    status: FetchProgressStatus,
    percent: number = 0,
    phase: string = "",
    bytesLoaded: number = 0,
    bytesTotal: number = 0
  ) => {
    hooks?.onProgress?.({
      url,
      status,
      percent,
      bytesLoaded,
      bytesTotal,
      phase,
    });
  };

  let finalUrl = url;
  let redirectCount = 0;

  // Validate URL
  updateProgress("connecting", 0, "validation");
  try {
    validateUrl(url);
  } catch (error) {
    if ((error as FetchError).code) {
      throw error;
    }
    throw createError("invalid_url", "validation", (error as Error).message, false, {
      url,
    });
  }

  // Get wreq-js
  const wreq = await getWreq();

  // Build request options
  const resolvedBrowser = resolveBrowserProfile(browser);
  const resolvedOS = resolveOSProfile(os);

  const requestHeaders = {
    ...DEFAULT_HEADERS,
    ...customHeaders,
  };

  // Main fetch loop (handles meta refresh redirects)
  while (redirectCount < MAX_REDIRECTS) {
    updateProgress("connecting", 10, "connecting");

    try {
      // wreq-js request
      const response = await wreq.fetch(finalUrl, {
        browser: resolvedBrowser,
        os: resolvedOS,
        timeout: timeoutMs,
        proxy,
        headers: requestHeaders,
      });

      updateProgress("waiting", 30, "waiting");

      // Check HTTP status
      if (!response.ok) {
        throw createError(
          "http_error",
          "waiting",
          `HTTP error: ${response.status} ${response.statusText}`,
          response.status >= 500 || response.status === 429,
          {
            url,
            finalUrl,
            statusCode: response.status,
            statusText: response.statusText,
          }
        );
      }

      updateProgress("loading", 40, "loading");

      // Get response body
      const buffer = await response.arrayBuffer();
      const contentLength = response.headers.get("content-length");
      const bytesTotal = contentLength ? parseInt(contentLength, 10) : buffer.byteLength;

      updateProgress("loading", 60, "loading", buffer.byteLength, bytesTotal);

      // Detect content type
      const { mimeType, isBinary } = detectContentType(response, buffer);

      // Handle binary content
      if (isBinary) {
        updateProgress("processing", 80, "processing");

        // For binary files, return a placeholder with metadata
        return createResult(url, finalUrl, `[Binary file: ${mimeType}]`, {
          mimeType,
          format,
        });
      }

      // Handle JSON
      if (mimeType === "application/json") {
        updateProgress("processing", 80, "processing");
        const text = new TextDecoder().decode(buffer);
        const json = JSON.parse(text);
        const content = JSON.stringify(json, null, 2);
        const truncated = truncateContent(content, maxChars);

        return createResult(url, finalUrl, truncated, {
          mimeType,
          format: "json",
        });
      }

      // Handle plain text
      if (mimeType.startsWith("text/plain")) {
        updateProgress("processing", 80, "processing");
        const text = new TextDecoder().decode(buffer);
        const truncated = truncateContent(text, maxChars);

        return createResult(url, finalUrl, truncated, {
          mimeType,
          format: "text",
        });
      }

      // Handle HTML
      updateProgress("processing", 70, "processing");

      const html = new TextDecoder().decode(buffer);
      const { document, window } = parseHTML(html);

      // Check for meta refresh redirect
      const redirectUrl = findMetaRefresh(document);
      if (redirectUrl) {
        redirectCount++;
        // Resolve relative URLs
        finalUrl = new URL(redirectUrl, finalUrl).href;
        continue; // Loop to fetch the redirect target
      }

      // Try defuddle extraction
      let content: string;
      let metadata: Partial<FetchResult> = {};

      try {
        const defuddle = await getDefuddle();

        // defuddle expects a window object with document
        const defuddleOptions = {
          removeImages,
          includeReplies: includeReplies === true ? true : includeReplies === "extractors" ? "extractors" : false,
        };

        const defuddleResult = await defuddle(window, defuddleOptions);

        if (defuddleResult?.content) {
          content = defuddleResult.content;
          metadata = extractMetadata(defuddleResult, document);
        } else {
          // Fallback to DOM extraction
          content = fallbackExtraction(document);
          metadata = extractMetadata(null, document);
        }
      } catch (defuddleError) {
        // Fallback to DOM extraction
        console.warn("[smart-fetch] Defuddle extraction failed, using fallback:", defuddleError);
        content = fallbackExtraction(document);
        metadata = extractMetadata(null, document);
      }

      // Truncate content
      content = truncateContent(content, maxChars);

      // Format content based on requested format
      const formattedContent = formatContent(
        createResult(url, finalUrl, content, metadata),
        format,
        maxChars
      );

      updateProgress("done", 100, "done", bytesTotal, bytesTotal);

      return createResult(url, finalUrl, formattedContent, {
        ...metadata,
        mimeType,
        format,
      });
    } catch (error) {
      // Handle wreq-js fetch errors
      if ((error as FetchError).code) {
        throw error;
      }

      const err = error as Error;

      // Classify error
      if (err.message.includes("timeout")) {
        throw createError("timeout", "waiting", err.message, true, {
          url,
          finalUrl,
          timeoutMs,
        });
      }

      if (err.message.includes("network") || err.message.includes("ECONNREFUSED")) {
        throw createError("network_error", "connecting", err.message, true, {
          url,
          finalUrl,
        });
      }

      throw createError("unexpected_response", "loading", err.message, false, {
        url,
        finalUrl,
      });
    }
  }

  // Too many redirects
  throw createError(
    "too_many_redirects",
    "processing",
    `Too many meta refresh redirects (${redirectCount})`,
    false,
    { url, finalUrl }
  );
}

/**
 * Fallback content extraction from DOM.
 */
function fallbackExtraction(document: Document): string {
  // Try article content first
  const article = document.querySelector("article, main, [role='main'], .content, #content");

  if (article) {
    return elementToMarkdown(article);
  }

  // Fall back to body
  const body = document.querySelector("body");
  if (body) {
    // Try to extract main content area
    const main = body.querySelector("main, article, [role='main']");
    if (main) {
      return elementToMarkdown(main);
    }
    return elementToMarkdown(body);
  }

  // Last resort: full document text
  return extractTextContent(document.documentElement);
}

/**
 * Fetch multiple URLs concurrently.
 *
 * @param urls - URLs to fetch
 * @param options - Fetch options
 * @param hooks - Execution hooks
 * @returns Batch fetch result
 */
export async function defuddleFetchMultiple(
  urls: string[],
  options: FetchOptions & { batchConcurrency?: number } = {},
  hooks?: FetchExecutionHooks
): Promise<BatchFetchResult> {
  const {
    batchConcurrency = DEFAULT_BATCH_CONCURRENCY,
    ...fetchOptions
  } = options;

  const items: BatchFetchItemResult[] = new Array(urls.length);
  const progress: FetchProgress[] = urls.map((url) => ({
    url,
    status: "queued" as FetchProgressStatus,
    percent: 0,
    bytesLoaded: 0,
    bytesTotal: 0,
    phase: "queued",
  }));

  // Worker function
  const fetchWorker = async (index: number): Promise<void> => {
    const url = urls[index];

    progress[index] = {
      url,
      status: "connecting",
      percent: 0,
      bytesLoaded: 0,
      bytesTotal: 0,
      phase: "connecting",
    };
    hooks?.onUpdate?.([...progress]);

    try {
      const result = await defuddleFetch(url, fetchOptions, {
        onProgress: (p) => {
          progress[index] = p;
          hooks?.onUpdate?.([...progress]);
        },
      });

      items[index] = { status: "done", result };
      progress[index] = {
        url,
        status: "done",
        percent: 100,
        bytesLoaded: progress[index].bytesTotal,
        bytesTotal: progress[index].bytesTotal,
        phase: "done",
      };
    } catch (error) {
      const fetchError = (error as FetchError).code
        ? (error as FetchError)
        : createError("processing_error", "unknown", (error as Error).message, false, { url });

      items[index] = { status: "error", error: fetchError };
      progress[index] = {
        url,
        status: "error",
        percent: 0,
        bytesLoaded: 0,
        bytesTotal: 0,
        phase: "error",
        error: fetchError,
      };
    }

    hooks?.onUpdate?.([...progress]);
  };

  // Bounded concurrency
  let nextIndex = 0;
  const workers: Promise<void>[] = [];

  const startWorker = (): void => {
    if (nextIndex >= urls.length) return;
    const index = nextIndex++;
    workers.push(
      fetchWorker(index).then(() => {
        // Start next worker after completion
        if (nextIndex < urls.length) {
          startWorker();
        }
      })
    );
  };

  // Start initial workers
  for (let i = 0; i < Math.min(batchConcurrency, urls.length); i++) {
    startWorker();
  }

  // Wait for all workers to complete
  await Promise.all(workers);

  // Calculate statistics
  const succeeded = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "error").length;

  return {
    total: urls.length,
    succeeded,
    failed,
    items,
  };
}
