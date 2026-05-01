/**
 * @unipi/web-api — Format & Error Builders
 *
 * Output formatting, content truncation, and error text builders.
 */

import type {
  FetchResult,
  FetchError,
  BatchFetchResult,
} from "./types.js";
import { DEFAULT_MAX_CHARS } from "./constants.js";

/** Truncation marker appended to truncated content */
const TRUNCATION_MARKER = "\n\n... [truncated]";

/**
 * Truncate content to a maximum character count.
 * Appends a truncation marker if content is shortened.
 *
 * @param content - Content to truncate
 * @param maxChars - Maximum characters
 * @returns Truncated content with marker if needed
 */
export function truncateContent(
  content: string,
  maxChars: number = DEFAULT_MAX_CHARS
): string {
  if (!content || content.length <= maxChars) {
    return content;
  }

  // Try to truncate at a word boundary
  const targetLength = maxChars - TRUNCATION_MARKER.length;
  let truncated = content.slice(0, targetLength);

  // Find last space to avoid cutting mid-word
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > targetLength * 0.8) {
    truncated = truncated.slice(0, lastSpace);
  }

  return truncated.trim() + TRUNCATION_MARKER;
}

/**
 * Format a FetchResult into the requested output format.
 *
 * @param result - Fetch result
 * @param format - Output format
 * @param maxChars - Maximum characters (optional)
 * @returns Formatted content string
 */
export function formatContent(
  result: FetchResult,
  format: "markdown" | "html" | "text" | "json" = "markdown",
  maxChars?: number
): string {
  let content: string;

  switch (format) {
    case "json":
      content = JSON.stringify(result, null, 2);
      break;

    case "html":
      // For now, return content as-is (defuddle outputs markdown)
      // A full implementation would convert markdown to HTML
      content = result.content;
      break;

    case "text":
      // Strip markdown formatting for plain text
      content = stripMarkdown(result.content);
      break;

    case "markdown":
    default:
      content = result.content;
      break;
  }

  return truncateContent(content, maxChars);
}

/**
 * Strip markdown formatting for plain text output.
 *
 * @param markdown - Markdown content
 * @returns Plain text
 */
function stripMarkdown(markdown: string): string {
  let text = markdown;

  // Remove headers
  text = text.replace(/^#{1,6}\s+/gm, "");

  // Remove bold/italic
  text = text.replace(/\*\*\*(.*?)\*\*\*/g, "$1");
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  text = text.replace(/\*(.*?)\*/g, "$1");
  text = text.replace(/___(.*?)___/g, "$1");
  text = text.replace(/__(.*?)__/g, "$1");
  text = text.replace(/_(.*?)_/g, "$1");

  // Remove links, keep text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // Remove images
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "");

  // Remove code blocks
  text = text.replace(/```[\s\S]*?```/g, "");
  text = text.replace(/`([^`]+)`/g, "$1");

  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, "");

  // Remove blockquotes
  text = text.replace(/^>\s+/gm, "");

  // Remove list markers
  text = text.replace(/^[\s]*[-*+]\s+/gm, "");
  text = text.replace(/^[\s]*\d+\.\s+/gm, "");

  // Clean up extra whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}

/**
 * Build a human-readable error message from a FetchError.
 *
 * @param error - Fetch error
 * @returns Human-readable error string
 */
export function buildErrorText(error: FetchError): string {
  const parts: string[] = [];

  // Main error message
  parts.push(error.error);

  // Code and phase context
  parts.push(`(${error.code} during ${error.phase})`);

  // URL context
  if (error.url) {
    if (error.finalUrl && error.finalUrl !== error.url) {
      parts.push(`URL: ${error.url} → ${error.finalUrl}`);
    } else {
      parts.push(`URL: ${error.url}`);
    }
  }

  // HTTP status
  if (error.statusCode) {
    parts.push(`Status: ${error.statusCode}${error.statusText ? ` ${error.statusText}` : ""}`);
  }

  // Network details
  if (error.mimeType) {
    parts.push(`Content-Type: ${error.mimeType}`);
  }
  if (error.contentLength !== undefined) {
    const sizeKB = Math.round(error.contentLength / 1024);
    parts.push(`Size: ${sizeKB} KB`);
  }
  if (error.downloadedBytes !== undefined && error.contentLength) {
    const percent = Math.round((error.downloadedBytes / error.contentLength) * 100);
    parts.push(`Downloaded: ${percent}%`);
  }

  // Retry hint
  if (error.retryable) {
    parts.push("This error may be retried.");
  } else {
    parts.push("This error is not retryable.");
  }

  return parts.join("\n");
}

/**
 * Format a single FetchResult for display.
 *
 * @param result - Fetch result
 * @param verbose - Include metadata header
 * @returns Formatted string
 */
export function formatSingleResult(
  result: FetchResult,
  verbose: boolean = true
): string {
  const lines: string[] = [];

  if (verbose) {
    // Metadata header
    lines.push(`# ${result.title || "Untitled"}`);
    lines.push("");
    lines.push(`URL: ${result.url}`);
    if (result.finalUrl !== result.url) {
      lines.push(`Final URL: ${result.finalUrl}`);
    }
    if (result.author) {
      lines.push(`Author: ${result.author}`);
    }
    if (result.published) {
      lines.push(`Published: ${result.published}`);
    }
    if (result.site) {
      lines.push(`Site: ${result.site}`);
    }
    if (result.language) {
      lines.push(`Language: ${result.language}`);
    }
    lines.push(`Word count: ${result.wordCount}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Content
  lines.push(result.content);

  return lines.join("\n");
}

/**
 * Format a BatchFetchResult for display.
 *
 * @param result - Batch fetch result
 * @returns Formatted string
 */
export function formatBatchResult(result: BatchFetchResult): string {
  const lines: string[] = [];

  // Summary header
  lines.push(`# Batch Read Results`);
  lines.push("");
  lines.push(
    `Total: ${result.total} · Succeeded: ${result.succeeded} · Failed: ${result.failed}`
  );
  lines.push("");

  // Per-item results
  for (let i = 0; i < result.items.length; i++) {
    const item = result.items[i];
    lines.push(`## [${i + 1}/${result.total}] ${item.status === "done" ? "✓" : "✗"}`);

    if (item.status === "done") {
      lines.push(`Title: ${item.result.title}`);
      lines.push(`URL: ${item.result.url}`);
      lines.push(`Words: ${item.result.wordCount}`);
      // Content preview (first 500 chars)
      const preview = item.result.content.slice(0, 500);
      lines.push("");
      lines.push(preview + (item.result.content.length > 500 ? "..." : ""));
    } else {
      lines.push(`URL: ${item.error.url || "unknown"}`);
      lines.push(`Error: ${item.error.error}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format a FetchError for display.
 *
 * @param error - Fetch error
 * @returns Formatted error string
 */
export function formatErrorResult(error: FetchError): string {
  const lines: string[] = [];

  lines.push(`# Fetch Error`);
  lines.push("");
  lines.push(`**${error.error}**`);
  lines.push("");
  lines.push(`Code: \`${error.code}\``);
  lines.push(`Phase: \`${error.phase}\``);

  if (error.url) {
    lines.push("");
    lines.push(`URL: ${error.url}`);
    if (error.finalUrl && error.finalUrl !== error.url) {
      lines.push(`Final URL: ${error.finalUrl}`);
    }
  }

  if (error.statusCode) {
    lines.push("");
    lines.push(`HTTP Status: ${error.statusCode}${error.statusText ? ` ${error.statusText}` : ""}`);
  }

  if (error.retryable) {
    lines.push("");
    lines.push(`*This error may be retried.*`);
  }

  return lines.join("\n");
}
