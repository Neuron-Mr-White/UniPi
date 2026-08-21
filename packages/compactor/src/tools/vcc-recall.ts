/**
 * session_recall / vcc_recall — session history search (pi-vcc parity).
 *
 * Hybrid keyword/regex search over the session branch, with:
 * - scope: lineage (active branch, default) | all
 * - pagination (page, 5 results/page)
 * - mode:"touched" — files worked on + entry indices
 * - #N:path drill-down into file content from an entry
 * - expand: entry indices returned as full untruncated content
 */

import type { NormalizedBlock } from "../types.js";
import { searchEntries, type RecallHit } from "../compaction/search-entries.js";
import { getTouchedFiles } from "../compaction/touched-files.js";
import { formatRecallOutput, formatTouchedOutput } from "../compaction/format-recall.js";
import { normalizeRecallScope, normalizeRecallMode, type RecallScope } from "../compaction/recall-scope.js";
import { parseDrillDown, expandEntryFile } from "../compaction/drill-down.js";

export const MAX_RECALL_RESULTS = 50;
export const MAX_EXPANDED_HIT_BYTES = 16 * 1024;
export const DEFAULT_RECENT = 25;
export const PAGE_SIZE = 5;

export interface RecallInput {
  query?: string;
  scope?: string;
  mode?: string;
  page?: number;
  expand?: number[];
}

export interface RecallResult {
  text: string;
}

function truncateExpandedHit(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_EXPANDED_HIT_BYTES) return text;
  const omitted = bytes.byteLength - MAX_EXPANDED_HIT_BYTES;
  const visible = bytes.subarray(0, MAX_EXPANDED_HIT_BYTES).toString("utf8").replace(/\uFFFD+$/u, "");
  return `${visible}\n… ${omitted} bytes omitted from this hit; narrow the query to inspect more specific context …`;
}

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

const scopeSuffix = (scope: RecallScope): string => (scope === "all" ? " (scope: all)" : "");

export function vccRecall(
  blocks: NormalizedBlock[],
  input: RecallInput,
): RecallResult {
  const scope = normalizeRecallScope(input.scope);

  // Drill-down: #N:path resolves to file-scoped tool content. Anchored so
  // inline mentions like "see #42:auth.ts" are never treated as drill-down.
  const q = input.query?.trim();
  if (q && parseDrillDown(q)) {
    const parsed = parseDrillDown(q)!;
    const text = expandEntryFile(blocks, parsed.index, parsed.pathPattern, parsed.full, parsed.offset, parsed.limit);
    return { text };
  }

  // touched mode: aggregate file operations across the searched window.
  if (normalizeRecallMode(input.mode) === "touched") {
    const touched = getTouchedFiles(blocks);
    return { text: formatTouchedOutput(touched, input.page) };
  }

  const expandSet = new Set(input.expand ?? []);
  const hasExpand = expandSet.size > 0;

  // expand without query: return full untruncated content for the indices
  if (hasExpand && !q) {
    const byIndex = new Map(blocks.map((b, i) => [b.sourceIndex ?? i, b]));
    const requested = [...expandSet];
    const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
    if (invalid.length > 0) {
      return {
        text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}`,
      };
    }
    const expanded = requested
      .sort((a, b) => a - b)
      .map((i) => byIndex.get(i))
      .filter((b): b is NormalizedBlock => Boolean(b));
    const lines = expanded.map((b) => {
      const idx = b.sourceIndex ?? 0;
      const text = truncateExpandedHit(b.kind === "tool_call" ? `${b.name} ${JSON.stringify(b.args)}` : b.text);
      return `#${idx} [${b.kind}] ${text}`;
    });
    return { text: (scope === "all" ? "Scope: all\n\n" : "") + lines.join("\n\n") };
  }

  const allResults = q ? searchEntries(blocks, q) : searchEntries(blocks).slice(-DEFAULT_RECENT);

  if (q) {
    const page = Math.max(1, input.page ?? 1);
    const start = (page - 1) * PAGE_SIZE;
    const pageResults: RecallHit[] = allResults.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
    if (pageResults.length === 0) {
      return { text: `No matches for "${q}"${scopeSuffix(scope)}${page > 1 ? ` on page ${page}` : ""}.` };
    }
    const header = totalPages > 1
      ? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix(scope)})`
      : `${allResults.length} matches${scopeSuffix(scope)}`;
    const footer = page < totalPages
      ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
      : "";
    return { text: formatRecallOutput(pageResults, q, header) + footer };
  }

  // No query: recent entries
  const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(allResults, q);
  return { text: output };
}
