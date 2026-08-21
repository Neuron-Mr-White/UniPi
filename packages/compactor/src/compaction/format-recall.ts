/** Recall output formatting (pi-vcc parity) */

import type { TouchedFile } from "./touched-files.js";
import type { RecallHit } from "./search-entries.js";

// ── Path shortening ───────────────────────────────────────────────────────

const CWD = process.cwd();

/**
 * Shorten an absolute file path for display:
 * - If within cwd, return `./relative/path`
 * - Otherwise, show last 3 path components with `.../` prefix
 * - Short paths (≤3 components) returned as-is
 */
export function shortPath(fullPath: string): string {
  const normalized = fullPath.replace(/\\/g, "/");
  const cwdNormalized = CWD.replace(/\\/g, "/");
  if (normalized.startsWith(cwdNormalized + "/")) {
    return "." + normalized.slice(cwdNormalized.length);
  }
  const parts = normalized.split("/");
  if (parts.length > 3) {
    return ".../" + parts.slice(-3).join("/");
  }
  return normalized;
}

// ── Touched file output ───────────────────────────────────────────────────

export const TOUCHED_PAGE_SIZE = 5;

export function formatTouchedOutput(
  touched: TouchedFile[],
  page?: number,
  pageSize?: number,
): string {
  if (touched.length === 0) {
    return "No file operations found in session history.";
  }

  const ps = pageSize ?? TOUCHED_PAGE_SIZE;
  const totalPages = Math.ceil(touched.length / ps);
  const currentPage = Math.max(1, page ?? 1);
  const start = (currentPage - 1) * ps;
  const pageFiles = touched.slice(start, start + ps);

  const header =
    totalPages > 1
      ? `Page ${currentPage}/${totalPages} (${touched.length} total files)`
      : `${touched.length} files touched`;

  const lines = pageFiles.map((tf) => {
    const displayPath = shortPath(tf.path);
    const indices = tf.entries
      .map((e) => `#${e.index} (${e.toolName})`)
      .join(", ");
    return `  ${displayPath}    ${indices}`;
  });

  let result = `${header}:\n\n${lines.join("\n")}`;

  if (currentPage < totalPages) {
    result += `\n\n--- Use page:${currentPage + 1} for more results ---`;
  }

  return result;
}

export const RECALL_PAGE_SIZE = 5;

export const formatRecallOutput = (
  hits: RecallHit[],
  query?: string,
  headerOverride?: string,
): string => {
  if (hits.length === 0) {
    return query
      ? `No matches for "${query}" in session history.`
      : "No entries in session history.";
  }

  const header = headerOverride
    ? `${headerOverride} for "${query}":`
    : query
      ? `Found ${hits.length} matches for "${query}":`
      : `Session history (${hits.length} entries):`;

  const lines = hits.map((h) => {
    const fileSuffix = h.files?.length ? ` files:[${h.files.join(", ")}]` : "";
    const body = h.snippet ?? h.text;
    return `#${h.index} [${h.kind}]${fileSuffix} ${body}`;
  });

  return `${header}\n\n${lines.join("\n\n")}`;
};
