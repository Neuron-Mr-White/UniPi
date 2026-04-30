/**
 * @pi-unipi/utility — Diff Parser
 *
 * Parses unified diffs from structuredPatch and provides word-level diff analysis.
 * Wraps the `diff` library for structured output.
 */

import * as Diff from "diff";

// ─── Types ──────────────────────────────────────────────────────────────────────

/** A single line in a parsed diff */
export interface DiffLine {
  /** Line type: added, removed, context, or hunk separator */
  type: "add" | "remove" | "context" | "hunk";
  /** Original line number (null for added lines) */
  oldLine: number | null;
  /** New line number (null for removed lines) */
  newLine: number | null;
  /** Line content (without +/- prefix) */
  content: string;
}

/** Result of parsing a diff */
export interface ParsedDiff {
  /** Old file name */
  oldName: string;
  /** New file name */
  newName: string;
  /** Parsed lines */
  lines: DiffLine[];
  /** Total additions */
  additions: number;
  /** Total deletions */
  deletions: number;
}

/** Word-level diff result */
export interface WordDiffResult {
  /** Similarity score (0-1, where 1 = identical) */
  similarity: number;
  /** Changed ranges in the new text */
  addedRanges: Array<{ start: number; end: number }>;
  /** Changed ranges in the old text */
  removedRanges: Array<{ start: number; end: number }>;
}

// ─── Diff Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a unified diff from two content strings.
 * Returns structured DiffLine[] with line numbers and hunk separators.
 *
 * @param oldContent - Original content
 * @param newContent - Modified content
 * @param context - Number of context lines around changes (default 3)
 * @param oldName - Label for old file
 * @param newName - Label for new file
 */
export function parseDiff(
  oldContent: string,
  newContent: string,
  context: number = 3,
  oldName: string = "old",
  newName: string = "new",
): ParsedDiff {
  // Handle edge cases
  if (oldContent === newContent) {
    return { oldName, newName, lines: [], additions: 0, deletions: 0 };
  }

  if (oldContent === "") {
    // New file — all lines are additions
    const lines = newContent.split("\n");
    const diffLines: DiffLine[] = lines.map((content, i) => ({
      type: "add" as const,
      oldLine: null,
      newLine: i + 1,
      content,
    }));
    return { oldName, newName, lines: diffLines, additions: lines.length, deletions: 0 };
  }

  if (newContent === "") {
    // Deleted file — all lines are removals
    const lines = oldContent.split("\n");
    const diffLines: DiffLine[] = lines.map((content, i) => ({
      type: "remove" as const,
      oldLine: i + 1,
      newLine: null,
      content,
    }));
    return { oldName, newName, lines: diffLines, additions: 0, deletions: lines.length };
  }

  // Use structuredPatch for unified diff
  const patches = Diff.structuredPatch(oldName, newName, oldContent, newContent, "", "", { context });

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const hunk of patches.hunks) {
    // Add hunk separator
    lines.push({
      type: "hunk",
      oldLine: hunk.oldStart,
      newLine: hunk.newStart,
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });

    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of hunk.lines) {
      const prefix = line[0];
      const content = line.substring(1);

      if (prefix === "+") {
        lines.push({ type: "add", oldLine: null, newLine, content });
        additions++;
        newLine++;
      } else if (prefix === "-") {
        lines.push({ type: "remove", oldLine, newLine: null, content });
        deletions++;
        oldLine++;
      } else {
        // Context line (space prefix)
        lines.push({ type: "context", oldLine, newLine, content });
        oldLine++;
        newLine++;
      }
    }
  }

  return { oldName, newName, lines, additions, deletions };
}

/**
 * Word-level diff analysis between two strings.
 * Returns similarity score and character ranges of changes.
 */
export function wordDiffAnalysis(a: string, b: string): WordDiffResult {
  // Fast path: identical strings
  if (a === b) {
    return { similarity: 1, addedRanges: [], removedRanges: [] };
  }

  // Fast path: empty strings
  if (a.length === 0 && b.length === 0) {
    return { similarity: 1, addedRanges: [], removedRanges: [] };
  }
  if (a.length === 0) {
    return { similarity: 0, addedRanges: [{ start: 0, end: b.length }], removedRanges: [] };
  }
  if (b.length === 0) {
    return { similarity: 0, addedRanges: [], removedRanges: [{ start: 0, end: a.length }] };
  }

  const changes = Diff.diffWords(a, b);

  const addedRanges: Array<{ start: number; end: number }> = [];
  const removedRanges: Array<{ start: number; end: number }> = [];
  let aPos = 0;
  let bPos = 0;
  let unchangedChars = 0;

  for (const change of changes) {
    if (change.added) {
      addedRanges.push({ start: bPos, end: bPos + (change.value?.length ?? 0) });
      bPos += change.value?.length ?? 0;
    } else if (change.removed) {
      removedRanges.push({ start: aPos, end: aPos + (change.value?.length ?? 0) });
      aPos += change.value?.length ?? 0;
    } else {
      // Unchanged
      unchangedChars += change.value?.length ?? 0;
      aPos += change.value?.length ?? 0;
      bPos += change.value?.length ?? 0;
    }
  }

  const totalChars = Math.max(a.length + b.length, 1);
  const similarity = (unchangedChars * 2) / totalChars;

  return {
    similarity: Math.min(1, Math.max(0, similarity)),
    addedRanges,
    removedRanges,
  };
}
