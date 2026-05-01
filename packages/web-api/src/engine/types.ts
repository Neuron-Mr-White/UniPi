/**
 * @unipi/web-api — Smart-Fetch Engine Types
 *
 * Type definitions for the local smart-fetch engine:
 * wreq-js (TLS fingerprinting) + defuddle (content extraction) + linkedom (server-side DOM).
 */

// ─── Error Types ───────────────────────────────────────────────

/** Structured error codes for fetch failures */
export type FetchErrorCode =
  | "invalid_url"
  | "unsupported_protocol"
  | "http_error"
  | "unexpected_response"
  | "timeout"
  | "network_error"
  | "processing_error"
  | "download_error"
  | "no_content"
  | "too_many_redirects";

/** Phase in the fetch pipeline where an error occurred */
export type FetchErrorPhase =
  | "validation"
  | "connecting"
  | "waiting"
  | "loading"
  | "processing"
  | "unknown";

/** Rich error with structured context for agent retry decisions */
export interface FetchError {
  /** Human-readable error message */
  error: string;
  /** Structured error category */
  code: FetchErrorCode;
  /** Where in the pipeline it failed */
  phase: FetchErrorPhase;
  /** Whether the agent can retry this request */
  retryable: boolean;
  /** Configured timeout in ms */
  timeoutMs?: number;
  /** Original URL requested */
  url?: string;
  /** Final URL after redirects */
  finalUrl?: string;
  /** HTTP status code (if applicable) */
  statusCode?: number;
  /** HTTP status text (if applicable) */
  statusText?: string;
  /** Response content type */
  mimeType?: string;
  /** Expected response size in bytes */
  contentLength?: number;
  /** Bytes downloaded before failure */
  downloadedBytes?: number;
}

// ─── Result Types ──────────────────────────────────────────────

/** Successful fetch result with full metadata */
export interface FetchResult {
  /** Original URL requested */
  url: string;
  /** Final URL after redirects */
  finalUrl: string;
  /** Page title */
  title: string;
  /** Article author (if extractable) */
  author: string;
  /** Publication date (ISO 8601 if available) */
  published: string;
  /** Site name */
  site: string;
  /** Content language (BCP 47) */
  language: string;
  /** Word count of extracted content */
  wordCount: number;
  /** Extracted and formatted content */
  content: string;
  /** Output format */
  format: "markdown" | "html" | "text" | "json";
  /** Response MIME type */
  mimeType: string;
}

// ─── Options ───────────────────────────────────────────────────

/** Options for the smart-fetch engine */
export interface FetchOptions {
  /** TLS fingerprint profile (e.g. "chrome_145") */
  browser?: string;
  /** OS fingerprint (e.g. "windows") */
  os?: string;
  /** Output format */
  format?: "markdown" | "html" | "text" | "json";
  /** Maximum characters in output content */
  maxChars?: number;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Strip image references from content */
  removeImages?: boolean;
  /** Include replies/comments: true, false, or "extractors" */
  includeReplies?: boolean | "extractors";
  /** Proxy URL */
  proxy?: string;
  /** Additional HTTP headers */
  headers?: Record<string, string>;
}

// ─── Batch Types ───────────────────────────────────────────────

/** Result for a single item in a batch fetch */
export type BatchFetchItemResult =
  | { status: "done"; result: FetchResult }
  | { status: "error"; error: FetchError };

/** Result of a batch fetch operation */
export interface BatchFetchResult {
  /** Total URLs requested */
  total: number;
  /** Successfully fetched */
  succeeded: number;
  /** Failed to fetch */
  failed: number;
  /** Per-item results in input order */
  items: BatchFetchItemResult[];
}

// ─── Progress Types ────────────────────────────────────────────

/** Status of a single URL in the fetch pipeline */
export type FetchProgressStatus =
  | "queued"
  | "connecting"
  | "waiting"
  | "loading"
  | "processing"
  | "done"
  | "error";

/** Progress update for a single URL */
export interface FetchProgress {
  /** URL being fetched */
  url: string;
  /** Current pipeline status */
  status: FetchProgressStatus;
  /** Progress percentage (0-100) */
  percent: number;
  /** Bytes loaded so far */
  bytesLoaded: number;
  /** Total bytes expected */
  bytesTotal: number;
  /** Current phase label */
  phase: string;
  /** Error details (if status is "error") */
  error?: FetchError;
}

// ─── Execution Hooks ───────────────────────────────────────────

/** Hooks for observing fetch execution progress */
export interface FetchExecutionHooks {
  /** Called with progress updates for a single URL fetch */
  onProgress?: (progress: FetchProgress) => void;
  /** Called with full progress snapshot for batch fetches */
  onUpdate?: (progress: FetchProgress[]) => void;
}
