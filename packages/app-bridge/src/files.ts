/**
 * `@` file suggestions for the phone composer: the same finder pi's TUI
 * editor uses (pi-tui CombinedAutocompleteProvider over fd, .gitignore
 * aware, scoped queries like `@src/` or `@~/notes`). Without fd it falls
 * back to a small bounded directory walk.
 */
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { FileItem } from "./wire.js";

const MAX_ITEMS = 30;
const TIMEOUT_MS = 4000;

let fdCache: string | null | undefined;
/** pi's own fd (~/.pi/agent/bin), else fd / fdfind on PATH, else null. */
export function findFd(): string | null {
  if (fdCache !== undefined) return fdCache;
  const exe = process.platform === "win32" ? ".exe" : "";
  try {
    const local = join(getAgentDir(), "bin", `fd${exe}`);
    if (existsSync(local)) return (fdCache = local);
  } catch {
    // no agent dir
  }
  for (const name of ["fd", "fdfind"]) {
    try {
      if (spawnSync(name, ["--version"], { stdio: "ignore", timeout: 2000 }).status === 0) return (fdCache = name);
    } catch {
      // not there
    }
  }
  return (fdCache = null);
}

const SKIP = new Set([".git", "node_modules", "target", "dist", ".next", ".cache"]);
/** No fd: a bounded breadth-first walk, substring match on the relative path. */
function walk(cwd: string, query: string): FileItem[] {
  const q = query.replace(/^"/, "").toLowerCase();
  const out: Array<FileItem & { score: number }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < 6000) {
    const { dir, depth } = queue.shift()!;
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      seen++;
      if (SKIP.has(d.name)) continue;
      const full = join(dir, d.name);
      const rel = relative(cwd, full).split(sep).join("/");
      const isDir = d.isDirectory();
      if (isDir && depth < 5) queue.push({ dir: full, depth: depth + 1 });
      const name = d.name.toLowerCase();
      const score = !q ? (depth === 0 ? 1 : 0) : name.startsWith(q) ? 80 : name.includes(q) ? 50 : rel.toLowerCase().includes(q) ? 30 : 0;
      if (!score) continue;
      const shown = isDir ? `${rel}/` : rel;
      const value = /[\s"']/.test(shown) ? `@"${shown}"` : `@${shown}`;
      out.push({ value, label: d.name + (isDir ? "/" : ""), path: rel, dir: isDir, score: score + (isDir ? 10 : 0) - depth });
    }
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return out.slice(0, MAX_ITEMS).map(({ score: _s, ...item }) => item);
}

/** Suggestions for the text typed after `@` (may start with `"`). */
export async function fileSuggestions(cwd: string, query: string): Promise<FileItem[]> {
  const fd = findFd();
  if (!fd) return walk(cwd, query);
  const provider = new CombinedAutocompleteProvider([], cwd, fd);
  const line = `@${query}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const result = await provider.getSuggestions([line], 0, line.length, { signal: ac.signal, force: true });
    return (result?.items ?? []).slice(0, MAX_ITEMS).map((i) => ({
      value: i.value,
      label: i.label,
      path: i.description ?? i.label,
      dir: i.label.endsWith("/"),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
