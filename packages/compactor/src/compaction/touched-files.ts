/**
 * Touched-file aggregation (pi-vcc parity, mode:"touched") — files worked on
 * with their entry indices, aggregated across the searched window.
 */

import type { NormalizedBlock } from "../types.js";
import { extractPath } from "./extract/files.js";

/** A file touched in one block — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
}

/** Aggregated view of a file touched across multiple blocks. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}

/** Aggregate file operations across tool_call blocks. */
export function getTouchedFiles(blocks: NormalizedBlock[]): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const path = extractPath(b.args);
    if (!path) continue;
    const index = b.sourceIndex ?? 0;
    if (!map.has(path)) {
      map.set(path, { path, entries: [] });
    }
    map.get(path)!.entries.push({ index, toolName: b.name });
  }
  return Array.from(map.values());
}
