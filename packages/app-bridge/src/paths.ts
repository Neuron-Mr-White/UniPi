/**
 * `paths_stat{paths[]}` (UNI-204): the phone found path-shaped tokens in
 * chat text (prose, inline/fenced code, tool output, markdown links) and
 * asks which of them actually exist on this PC, so only real files become
 * tappable. One batched request per render; the phone caches the answers.
 *
 * Resolution, per path:
 * - `~` / `~/…` expands against $HOME; absolute passes through; anything
 *   else resolves against the session cwd.
 * - Policy (same scope as the host's fs access / `file_share`): the
 *   resolved path must sit inside the session cwd or inside $HOME —
 *   anything else answers `missing` (never says whether it exists).
 * - A relative path that doesn't exist at the cwd (`Composer.tsx`,
 *   `src/lib/chat/store.ts` said from a sub-package's point of view) is
 *   looked up as a path SUFFIX in a cached listing of the cwd tree; a
 *   unique match wins, an ambiguous one stays `missing`.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import { findFd } from "./files.js";

export const PATHS_STAT_MAX = 200;
export const PATH_MAX_CHARS = 4096;

export type PathKind = "file" | "dir" | "missing";
export type PathStat = { path: string; resolved: string; kind: PathKind };

/** Whether `target` (absolute) is `root` or inside it. */
function inside(target: string, root: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(target));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
}

/** `~`-expansion + cwd resolution, no I/O. */
export function resolveAgainst(path: string, cwd: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return resolvePath(cwd, path);
}

const kindOf = (abs: string): PathKind => {
  try {
    const st = statSync(abs);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "missing";
  } catch {
    return "missing";
  }
};

// ---- cwd tree index (suffix lookup) ----------------------------------------

const INDEX_TTL_MS = 60_000;
const INDEX_MAX = 50_000;
const INDEX_TIMEOUT_MS = 2000;
const SKIP = new Set([".git", "node_modules", "target", "dist", ".next", ".cache", ".turbo", "build"]);
type TreeIndex = { at: number; files: string[]; dirs: string[] };
const indexCache = new Map<string, { at: number; index: Promise<TreeIndex> }>();

/** Relative paths (POSIX separators) of files and dirs under `cwd`, gitignore NOT applied
 * (nested repos are often gitignored by the outer one, and a model names them all the same),
 * heavy build/vendor dirs skipped. fd (async, never blocks pi's event loop) when available,
 * else a bounded walk. Cached ~60 s per cwd. */
export function treeIndex(cwd: string, now = Date.now()): Promise<TreeIndex> {
  const hit = indexCache.get(cwd);
  if (hit && now - hit.at < INDEX_TTL_MS) return hit.index;
  const index = buildIndex(cwd, now);
  indexCache.set(cwd, { at: now, index });
  return index;
}

function buildIndex(cwd: string, now: number): Promise<TreeIndex> {
  const fd = findFd();
  const walked = (): TreeIndex => {
    const files: string[] = [];
    const dirs: string[] = [];
    walkTree(cwd, files, dirs);
    return { at: now, files, dirs };
  };
  if (!fd) return Promise.resolve(walked());
  const args = ["--hidden", "--no-ignore-vcs", "--color", "never", "--max-results", String(INDEX_MAX)];
  for (const s of SKIP) args.push("-E", s);
  args.push("-t", "f", "-t", "d", ".", cwd);
  return new Promise<TreeIndex>((resolve) => {
    let out = "";
    let settled = false;
    const files: string[] = [];
    const dirs: string[] = [];
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) return resolve(walked());
      for (const line of out.split("\n")) {
        if (!line) continue;
        const isDir = line.endsWith("/");
        const rel = relative(cwd, line).split(sep).join("/");
        if (!rel || rel.startsWith("..")) continue;
        (isDir ? dirs : files).push(rel);
      }
      resolve({ at: now, files, dirs });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(fd, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(walked());
    }
    // Too slow (a huge tree): use what arrived so far rather than nothing.
    const timer = setTimeout(() => {
      child.kill();
      finish(true);
    }, INDEX_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      if (out.length < 16 * 1024 * 1024) out += d;
    });
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 || out.length > 0));
  });
}

function walkTree(cwd: string, files: string[], dirs: string[]): void {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: cwd, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < INDEX_MAX) {
    const { dir, depth } = queue.shift()!;
    let names: import("node:fs").Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (SKIP.has(d.name)) continue;
      seen++;
      const full = join(dir, d.name);
      const rel = relative(cwd, full).split(sep).join("/");
      if (d.isDirectory()) {
        dirs.push(rel);
        if (depth < 10) queue.push({ dir: full, depth: depth + 1 });
      } else files.push(rel);
    }
  }
}

/** Test hook. */
export function clearTreeIndex(): void {
  indexCache.clear();
}

/** The single entry of the index whose path is `rel` or ends with `/rel`; undefined when none or several. */
function suffixMatch(idx: TreeIndex, rel: string): { rel: string; kind: PathKind } | undefined {
  const wantDir = rel.endsWith("/");
  const needle = rel.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!needle || needle.startsWith("../")) return undefined;
  const tail = `/${needle}`;
  let found: { rel: string; kind: PathKind } | undefined;
  const scan = (list: string[], kind: PathKind) => {
    for (const p of list) {
      if (p === needle || p.endsWith(tail)) {
        if (found && found.rel !== p) return false; // ambiguous
        found = { rel: p, kind };
      }
    }
    return true;
  };
  if (!wantDir && !scan(idx.files, "file")) return undefined;
  if (!scan(idx.dirs, "dir")) return undefined;
  return found;
}

/** Answers one `paths_stat` request (see module doc). Never rejects. The suffix lookup is skipped
 * when the cwd is $HOME or `/` (a tree that size says nothing useful about a bare `index.ts`). */
export async function statPaths(paths: readonly string[], cwd: string, home = homedir()): Promise<PathStat[]> {
  const out: PathStat[] = [];
  const indexable = resolvePath(cwd) !== resolvePath(home) && resolvePath(cwd) !== "/";
  let idx: TreeIndex | undefined;
  for (const raw of paths.slice(0, PATHS_STAT_MAX)) {
    const path = String(raw).slice(0, PATH_MAX_CHARS);
    const resolved = resolveAgainst(path, cwd, home);
    if (!inside(resolved, cwd) && !inside(resolved, home)) {
      out.push({ path, resolved, kind: "missing" });
      continue;
    }
    let kind = kindOf(resolved);
    let at = resolved;
    const relativeSpelling = !path.startsWith("/") && !path.startsWith("~") && !path.startsWith("../");
    if (kind === "missing" && relativeSpelling && indexable) {
      try {
        idx ??= await treeIndex(cwd);
        const m = suffixMatch(idx, path);
        if (m) {
          at = join(cwd, m.rel);
          kind = kindOf(at);
        }
      } catch {
        // no index: stays missing
      }
    }
    out.push({ path, resolved: kind === "missing" ? resolved : at, kind });
  }
  return out;
}
