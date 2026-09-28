/**
 * @pi-unipi/utility — Stale cleanup (allowlist only)
 *
 * Only the targets listed in TARGETS can ever be removed. Everything else
 * under ~/.unipi — memory, v2 backups, kanboard boards, config, workspace
 * state — is out of reach by construction, not by pattern luck. Callers
 * preview first (`dryRun`) and delete only after the user confirms.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface CleanupTarget {
  id: string;
  label: string;
  /** Directory scanned (non-recursive). */
  dir: () => string;
  /** Entry names that belong to this target. */
  match: RegExp;
  /** Minimum age in days; 0 = any age (the feature that wrote it is gone). */
  minAgeDays: number;
  /** Entry kind to consider. */
  kind: "file" | "dir" | "any";
}

const unipi = (...parts: string[]) => join(homedir(), ".unipi", ...parts);

export const TARGETS: readonly CleanupTarget[] = [
  {
    id: "tool-results",
    label: "Saved tool outputs older than 7 days",
    dir: () => unipi("tool-results"),
    match: /^(?:tool-result|mcp-[a-zA-Z0-9_-]+|helper)-[a-f0-9-]+\.txt$/,
    minAgeDays: 7,
    kind: "file",
  },
  {
    id: "temp",
    label: "UniPi temp files older than 7 days",
    dir: () => tmpdir(),
    match: /^unipi-/,
    minAgeDays: 7,
    kind: "file",
  },
  {
    id: "compactor-db",
    label: "Old compactor continuity database (no longer used)",
    dir: () => unipi("db"),
    match: /^compactor$/,
    minAgeDays: 0,
    kind: "dir",
  },
  {
    id: "compactor-db-global",
    label: "Old compactor continuity database (no longer used)",
    dir: () => unipi("global"),
    match: /^compactor$/,
    minAgeDays: 0,
    kind: "dir",
  },
];

export interface CleanupItem {
  target: string;
  path: string;
  bytes: number;
}

export interface CleanupResult {
  items: CleanupItem[];
  removed: number;
  bytes: number;
  failed: string[];
}

function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    return readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0);
  } catch {
    return 0;
  }
}

/** Everything the allowlist would remove right now. Never deletes. */
export function findCleanupItems(targets: readonly CleanupTarget[] = TARGETS, now = Date.now()): CleanupItem[] {
  const items: CleanupItem[] = [];
  for (const target of targets) {
    const dir = target.dir();
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!target.match.test(name)) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (target.kind === "file" && !st.isFile()) continue;
        if (target.kind === "dir" && !st.isDirectory()) continue;
        if (target.minAgeDays > 0 && now - st.mtimeMs < target.minAgeDays * 86_400_000) continue;
        items.push({ target: target.id, path, bytes: sizeOf(path) });
      } catch {
        // Unreadable entry — skip.
      }
    }
  }
  return items;
}

/** Delete exactly the previewed items (re-validated against the allowlist). */
export function removeCleanupItems(items: readonly CleanupItem[], targets: readonly CleanupTarget[] = TARGETS): CleanupResult {
  const allowed = new Set(findCleanupItems(targets).map((i) => i.path));
  const result: CleanupResult = { items: [...items], removed: 0, bytes: 0, failed: [] };
  for (const item of items) {
    if (!allowed.has(item.path)) continue;
    try {
      rmSync(item.path, { recursive: true, force: true });
      result.removed++;
      result.bytes += item.bytes;
    } catch {
      result.failed.push(item.path);
    }
  }
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Preview grouped by target — what the confirm dialog and dry run show. */
export function formatCleanupPreview(items: readonly CleanupItem[], targets: readonly CleanupTarget[] = TARGETS): string {
  if (items.length === 0) return "Nothing to clean.";
  const total = items.reduce((sum, i) => sum + i.bytes, 0);
  const lines = [`${items.length} item(s), ${formatBytes(total)}:`];
  for (const target of targets) {
    const mine = items.filter((i) => i.target === target.id);
    if (mine.length === 0) continue;
    lines.push(`- ${target.label}: ${mine.length} (${formatBytes(mine.reduce((s, i) => s + i.bytes, 0))})`);
    for (const item of mine.slice(0, 5)) lines.push(`    ${item.path}`);
    if (mine.length > 5) lines.push(`    … and ${mine.length - 5} more`);
  }
  return lines.join("\n");
}
