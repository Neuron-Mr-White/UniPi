/**
 * @unipi/web-api — TUI Result Renderer
 *
 * Renders single and batch results for TUI display.
 */

import type { FetchResult, BatchFetchResult, FetchError } from "../engine/types.js";

/** Maximum preview lines */
const PREVIEW_LINES = 7;

/**
 * Truncate content for preview.
 *
 * @param content - Content to preview
 * @param maxLines - Maximum lines
 * @returns Preview string
 */
function truncatePreview(content: string, maxLines: number = PREVIEW_LINES): string {
  const lines = content.split("\n").slice(0, maxLines);
  return lines.join("\n");
}

/**
 * Render a single result for display.
 *
 * @param result - Fetch result
 * @param verbose - Include metadata header
 * @returns Formatted string
 */
export function renderSingleResult(
  result: FetchResult,
  verbose: boolean = true
): string {
  const lines: string[] = [];

  if (verbose) {
    // Title
    lines.push(`# ${result.title || "Untitled"}`);
    lines.push("");

    // Metadata
    const meta: string[] = [];
    if (result.author) {
      meta.push(`Author: ${result.author}`);
    }
    if (result.published) {
      meta.push(`Published: ${result.published}`);
    }
    if (result.site) {
      meta.push(`Site: ${result.site}`);
    }
    if (result.language) {
      meta.push(`Language: ${result.language}`);
    }
    if (result.wordCount) {
      meta.push(`Words: ${result.wordCount}`);
    }

    if (meta.length > 0) {
      lines.push(meta.join(" · "));
    }

    // URL
    lines.push(`URL: ${result.url}`);
    if (result.finalUrl !== result.url) {
      lines.push(`Final URL: ${result.finalUrl}`);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Content preview
  const preview = truncatePreview(result.content);
  lines.push(preview);

  // Expand hint
  if (result.content.split("\n").length > PREVIEW_LINES) {
    lines.push("");
    lines.push(`... [${result.wordCount} words total · Ctrl+O to expand]`);
  }

  return lines.join("\n");
}

/**
 * Render a batch result for display.
 *
 * @param result - Batch fetch result
 * @returns Formatted string
 */
export function renderBatchResult(result: BatchFetchResult): string {
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
    const status = item.status === "done" ? "✓" : "✗";

    lines.push(`## [${i + 1}/${result.total}] ${status}`);

    if (item.status === "done") {
      lines.push(`**${item.result.title}**`);
      lines.push(`URL: ${item.result.url}`);
      lines.push(`Words: ${item.result.wordCount}`);
      lines.push("");

      // Content preview
      const preview = truncatePreview(item.result.content);
      lines.push(preview);

      if (item.result.content.split("\n").length > PREVIEW_LINES) {
        lines.push("...");
      }
    } else {
      lines.push(`URL: ${item.error.url || "unknown"}`);
      lines.push(`Error: ${item.error.error}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Render an error result for display.
 *
 * @param error - Fetch error
 * @returns Formatted string
 */
export function renderErrorResult(error: FetchError): string {
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
    lines.push(
      `HTTP Status: ${error.statusCode}${error.statusText ? ` ${error.statusText}` : ""}`
    );
  }

  if (error.retryable) {
    lines.push("");
    lines.push(`*This error may be retried.*`);
  }

  return lines.join("\n");
}
