/**
 * File tracking — Modified/Created/Read, dedup, path trimming
 */

import type { NormalizedBlock } from "../../types.js";

const PATH_RE = /(?:[\w\-]+\/)+[\w\-]+(?:\.[\w\-]+)?/g;
const EDIT_RE = /\b(edit|modify|update|change|patch|rewrite|refactor)\b/i;
const CREATE_RE = /\b(create|write|add|new|generate|make)\b/i;
const READ_RE = /\b(read|view|show|inspect|check|look|open|cat|head|tail|grep|find|ls)\b/i;

export interface FileActivity {
  modified: Set<string>;
  created: Set<string>;
  read: Set<string>;
}

export function extractFiles(blocks: NormalizedBlock[]): FileActivity {
  const activity: FileActivity = {
    modified: new Set(),
    created: new Set(),
    read: new Set(),
  };

  for (const b of blocks) {
    if (b.kind === "tool_call") {
      const path = extractPath(b.args);
      if (!path) continue;
      if (b.name === "edit" || b.name === "Edit") activity.modified.add(path);
      else if (b.name === "write" || b.name === "Write") activity.created.add(path);
      else if (b.name === "read" || b.name === "Read") activity.read.add(path);
      continue;
    }

    if (b.kind !== "user" && b.kind !== "assistant") continue;
    const text = b.text;
    const paths = text.match(PATH_RE) ?? [];
    for (const p of paths) {
      if (p.split("/").length < 2) continue; // require at least one directory
      const context = text.slice(Math.max(0, text.indexOf(p) - 40), text.indexOf(p) + p.length + 40);
      if (EDIT_RE.test(context)) activity.modified.add(p);
      else if (CREATE_RE.test(context)) activity.created.add(p);
      else if (READ_RE.test(context)) activity.read.add(p);
    }
  }

  return activity;
}

/** Extract a file path from tool args */
export function extractPath(args: Record<string, unknown>): string | undefined {
  const candidates = ["file_path", "path", "filePath", "filepath", "file"];
  for (const key of candidates) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return undefined;
}
