/**
 * @unipi/web-api — Engine Constants
 *
 * Default values for the smart-fetch engine.
 */

/** Default browser TLS fingerprint profile */
export const DEFAULT_BROWSER = "chrome_145";

/** Default OS fingerprint */
export const DEFAULT_OS = "windows";

/** Default maximum content length in characters */
export const DEFAULT_MAX_CHARS = 50000;

/** Default request timeout in milliseconds */
export const DEFAULT_TIMEOUT_MS = 15000;

/** Default batch concurrency */
export const DEFAULT_BATCH_CONCURRENCY = 8;

/** Default removeImages setting */
export const DEFAULT_REMOVE_IMAGES = false;

/** Default includeReplies setting */
export const DEFAULT_INCLUDE_REPLIES: boolean | "extractors" = "extractors";

/** Default output format */
export const DEFAULT_FORMAT = "markdown" as const;

/** Default HTTP headers */
export const DEFAULT_HEADERS: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
