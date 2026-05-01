/**
 * @unipi/web-api — TUI Progress Renderer
 *
 * Renders batch fetch progress for TUI display.
 */

import type { FetchProgress, FetchProgressStatus } from "../engine/types.js";

/** Spinner frames for animation */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Status glyphs */
const STATUS_GLYPHS: Record<FetchProgressStatus, string> = {
  queued: "○",
  connecting: SPINNER_FRAMES[0],
  waiting: SPINNER_FRAMES[0],
  loading: SPINNER_FRAMES[0],
  processing: SPINNER_FRAMES[0],
  done: "✓",
  error: "✗",
};

/**
 * Get a spinner frame for the given index.
 * Cycles through spinner frames for animation.
 *
 * @param index - Animation frame index
 * @returns Spinner character
 */
export function getSpinnerFrame(index: number): string {
  return SPINNER_FRAMES[index % SPINNER_FRAMES.length];
}

/**
 * Render a progress bar.
 *
 * @param percent - Progress percentage (0-100)
 * @param width - Bar width in characters
 * @returns Progress bar string
 */
export function renderProgressBar(percent: number, width: number = 10): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/**
 * Truncate a URL for display.
 *
 * @param url - URL to truncate
 * @param maxLength - Maximum length
 * @returns Truncated URL
 */
function truncateUrl(url: string, maxLength: number): string {
  if (url.length <= maxLength) {
    return url;
  }

  // Try to keep the domain
  try {
    const parsed = new URL(url);
    const domain = parsed.host;
    const path = parsed.pathname + parsed.search;

    if (domain.length + 3 >= maxLength) {
      return url.slice(0, maxLength - 1) + "…";
    }

    const remaining = maxLength - domain.length - 3;
    if (path.length <= remaining) {
      return domain + path;
    }

    return domain + path.slice(0, remaining - 1) + "…";
  } catch {
    return url.slice(0, maxLength - 1) + "…";
  }
}

/**
 * Render a single progress item line.
 *
 * @param progress - Progress object
 * @param width - Available width
 * @param spinnerIndex - Animation frame index
 * @returns Formatted line
 */
export function renderProgressLine(
  progress: FetchProgress,
  width: number = 80,
  spinnerIndex: number = 0
): string {
  // Status glyph
  let glyph = STATUS_GLYPHS[progress.status];
  if (["connecting", "waiting", "loading", "processing"].includes(progress.status)) {
    glyph = getSpinnerFrame(spinnerIndex);
  }

  // Truncate URL
  const urlMax = Math.min(40, width - 30);
  const url = truncateUrl(progress.url, urlMax);

  // Progress bar
  const bar = renderProgressBar(progress.percent, 8);

  // Status text
  const statusText = progress.phase || progress.status;

  // Format line
  return `${glyph} ${url.padEnd(urlMax)}  ${statusText.padEnd(12)} [${bar}]`;
}

/**
 * Render batch progress header.
 *
 * @param progress - All progress items
 * @param concurrency - Current concurrency
 * @returns Header line
 */
export function renderBatchProgressHeader(
  progress: FetchProgress[],
  concurrency: number
): string {
  const total = progress.length;
  const done = progress.filter((p) => p.status === "done").length;
  const error = progress.filter((p) => p.status === "error").length;
  const active = progress.filter(
    (p) => !["queued", "done", "error"].includes(p.status)
  ).length;

  return `batch_web_content_read ${done}/${total} done · ok ${done - error} · err ${error} · concurrency ${concurrency}`;
}

/**
 * Render full batch progress display.
 *
 * @param progress - All progress items
 * @param concurrency - Current concurrency
 * @param width - Available width
 * @param spinnerIndex - Animation frame index
 * @returns Formatted string
 */
export function renderBatchProgress(
  progress: FetchProgress[],
  concurrency: number = 8,
  width: number = 80,
  spinnerIndex: number = 0
): string {
  const lines: string[] = [];

  // Header
  lines.push(renderBatchProgressHeader(progress, concurrency));
  lines.push("");

  // Progress items (show up to 10)
  const maxItems = 10;
  const itemsToShow = progress.slice(0, maxItems);

  for (const item of itemsToShow) {
    lines.push(renderProgressLine(item, width, spinnerIndex));
  }

  if (progress.length > maxItems) {
    lines.push(`  ... and ${progress.length - maxItems} more`);
  }

  return lines.join("\n");
}
