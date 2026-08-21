/**
 * Drill-down: resolve #N:path syntax to tool call file content (pi-vcc parity).
 *
 * Supports: #42:auth.ts (preview), #42:auth.ts:full (full content),
 * #42:auth.ts:30 (offset), #42:auth.ts:30:20 (offset:limit).
 */

import type { NormalizedBlock } from "../types.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface ContentBearingCall {
  name: string;
  path: string;
  content?: string;
  oldText?: string;
  newText?: string;
  edits?: Array<{ oldText?: string; newText?: string }>;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file"] as const;

/** Extract a file path from tool args */
const extractPath = (args: Record<string, unknown>): string | undefined => {
  for (const key of PATH_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
};

/**
 * A call is content-bearing if it has a path argument AND at least one
 * large string/array field (content, edits, oldText, newText).
 */
export const isContentBearing = (args: Record<string, unknown>): boolean => {
  if (!args || typeof args !== "object") return false;
  const hasPath = PATH_KEYS.some((k) => typeof args[k] === "string");
  if (!hasPath) return false;
  if (typeof args.content === "string" && args.content.length > 0) return true;
  if (
    Array.isArray(args.edits) &&
    args.edits.length > 0 &&
    args.edits.every((e) => typeof e === "object" && e !== null)
  )
    return true;
  if (typeof args.oldText === "string" && args.oldText.length > 0 && args.edits === undefined)
    return true;
  if (typeof args.newText === "string" && args.newText.length > 0 && args.edits === undefined)
    return true;
  return false;
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Find content-bearing tool_call blocks with a path arg and content fields. */
function findContentBearingCalls(blocks: NormalizedBlock[]): ContentBearingCall[] {
  const results: ContentBearingCall[] = [];
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    if (!isContentBearing(b.args)) continue;
    const path = extractPath(b.args);
    if (!path) continue;
    const entry: ContentBearingCall = { name: b.name, path };
    if (typeof b.args.content === "string") entry.content = b.args.content;
    if (Array.isArray(b.args.edits)) {
      entry.edits = (b.args.edits as unknown[]).filter(
        (e): e is { oldText?: string; newText?: string } =>
          e !== null && typeof e === "object",
      );
    }
    if (typeof b.args.oldText === "string" && !Array.isArray(b.args.edits))
      entry.oldText = b.args.oldText;
    if (typeof b.args.newText === "string" && !Array.isArray(b.args.edits))
      entry.newText = b.args.newText;
    results.push(entry);
  }
  return results;
}

/** Format content for display with optional offset/limit slicing. */
function formatToolCallContent(
  tc: ContentBearingCall,
  entryIndex: number,
  options?: { full?: boolean; offset?: number; limit?: number },
): string {
  let body: string;
  if (tc.content) {
    body = tc.content;
  } else if (tc.edits) {
    body = tc.edits
      .map(
        (e, i) =>
          `--- edit ${i + 1} ---\n${e.oldText ?? ""}\n--- becomes ---\n${e.newText ?? ""}`,
      )
      .join("\n\n");
  } else if (tc.oldText && tc.newText) {
    body = `--- old ---\n${tc.oldText}\n--- new ---\n${tc.newText}`;
  } else {
    body = "(no file content found in tool call arguments)";
  }

  const full = options?.full ?? false;
  const offset = options?.offset;
  const limit = options?.limit;
  const allLines = body.split("\n");
  const totalLines = allLines.length;
  const previewLimit = 30;
  const MAX_FULL_BYTES = 50 * 1024;

  if (full) {
    if (Buffer.byteLength(body, "utf8") > MAX_FULL_BYTES) {
      const truncated = body.slice(0, MAX_FULL_BYTES);
      return `File: ${tc.path}
Tool: ${tc.name}

${truncated}

... (${Buffer.byteLength(body, "utf8") - MAX_FULL_BYTES} more bytes — file exceeds 50KB display limit. Use #${entryIndex}:${tc.path}:${previewLimit} for next page.)`;
    }
    return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
  }

  if (offset !== undefined) {
    const startLine = Math.max(0, offset);
    const maxLines = limit ?? 30;
    const endLine = Math.min(startLine + maxLines, totalLines);
    const visible = allLines.slice(startLine, endLine);
    const displayStart = startLine + 1;

    if (visible.length === 0) {
      return `Offset ${startLine} is beyond file length ${totalLines}. Use #${entryIndex}:${tc.path} for the first ${previewLimit} lines.`;
    }

    let result = `File: ${tc.path}
Tool: ${tc.name}
Lines ${displayStart}-${endLine} (of ${totalLines}):

`;
    result += visible.join("\n");

    if (endLine < totalLines) {
      result += `\n\n--- Use #${entryIndex}:${tc.path}:${endLine} or #${entryIndex}:${tc.path}:${endLine}:${maxLines} for next ${maxLines} lines, #${entryIndex}:${tc.path}:full for complete ---`;
    } else if (offset > 0) {
      result += `\n\n(End of file)`;
    }

    return result;
  }

  // Default preview mode: first ${previewLimit} lines
  if (totalLines > previewLimit) {
    const preview = allLines.slice(0, previewLimit).join("\n");
    return `File: ${tc.path}
Tool: ${tc.name}

${preview}

...(${totalLines - previewLimit} more lines — use #${entryIndex}:${tc.path}:full for complete content, or #${entryIndex}:${tc.path}:${previewLimit} for next ${previewLimit} lines)`;
  }

  return `File: ${tc.path}
Tool: ${tc.name}

${body}`;
}

// ── Parse drill-down query ────────────────────────────────────────────────

/**
 * Pattern: #N:path, #N:path:full, #N:path:offset, or #N:path:offset:limit.
 * The ^ anchor requires the entire query to be the drill-down pattern, so
 * inline mentions like "see #42:auth.ts" are never treated as drill-down.
 */
const DRILLDOWN_PATTERN = /^#(\d+):(.+?)(?::(full|\d+(?::\d+)?))?$/;

export function parseDrillDown(query: string): {
  index: number;
  pathPattern: string;
  full: boolean;
  offset?: number;
  limit?: number;
} | null {
  const match = query.match(DRILLDOWN_PATTERN);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  const pathPattern = match[2];
  const suffix = match[3];

  if (suffix === "full") {
    return { index, pathPattern, full: true, offset: undefined, limit: undefined };
  }

  if (suffix !== undefined) {
    const parts = suffix.split(":");
    const offset = parseInt(parts[0], 10);
    const limit = parts[1] !== undefined ? parseInt(parts[1], 10) : undefined;
    if (!Number.isNaN(offset)) {
      return { index, pathPattern, full: false, offset, limit };
    }
  }

  return { index, pathPattern, full: false, offset: undefined, limit: undefined };
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Expand a drill-down query (#N:path) to tool call content from blocks whose
 * sourceIndex matches the entry index.
 */
export function expandEntryFile(
  blocks: NormalizedBlock[],
  entryIndex: number,
  pathPattern: string,
  full = false,
  offset?: number,
  limit?: number,
): string {
  const entryBlocks = blocks.filter((b) => b.sourceIndex === entryIndex);
  if (entryBlocks.length === 0) {
    return `Entry #${entryIndex} not found in session history.`;
  }

  const calls = findContentBearingCalls(entryBlocks);

  // Special case: #42:file keyword
  if (pathPattern === "file") {
    if (calls.length === 0) {
      return `No file content found in entry #${entryIndex}.`;
    }
    if (calls.length === 1) {
      return formatToolCallContent(calls[0], entryIndex, { full, offset, limit });
    }
    const items = calls.map(
      (tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`,
    );
    return `Entry #${entryIndex} has ${calls.length} file operations:\n${items.join("\n")}\n\nUse #${entryIndex}:path to drill into a specific file.`;
  }

  const matched = calls.filter((tc) => tc.path.includes(pathPattern));

  if (matched.length === 0) {
    return `No file content found in entry #${entryIndex} for "${pathPattern}".`;
  }

  if (matched.length > 1) {
    const items = matched.map(
      (tc) => `  [#${entryIndex}:${tc.path}] ${tc.name}(${tc.path})`,
    );
    return `Entry #${entryIndex} has ${matched.length} file operations matching "${pathPattern}":
${items.join("\n")}

Use #${entryIndex}:<more-specific-path> to drill into a specific file.`;
  }

  return formatToolCallContent(matched[0], entryIndex, { full, offset, limit });
}
