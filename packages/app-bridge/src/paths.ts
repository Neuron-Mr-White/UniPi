/**
 * `paths_stat{paths[]}` (UNI-204): the phone found path-shaped tokens in
 * chat text (prose, inline/fenced code, tool output, markdown links) and
 * asks which of them actually exist on this PC, so only real files become
 * tappable. One batched request per render; the phone caches the answers.
 *
 * Resolution, per path:
 * - `~` / `~/…` expands against $HOME; absolute passes through; anything
 *   else resolves against the session cwd.
 * - Policy (same scope as the host's fs access): the resolved path must
 *   sit inside the session cwd, inside $HOME, or (UNI-220) inside one of
 *   the host's extra safe roots — `/tmp`, `/var/tmp`, `/mnt`, `/media`,
 *   `/run/media/$USER`, `/srv`, `/opt` when they exist, plus/minus the
 *   owner's `unipi-host fs allow|deny` (`config.json` `fs` block). Extra
 *   roots are judged on the realpath, so a symlink can't escape them.
 *   Anything else answers `missing` (never says whether it exists).
 * - A relative path that doesn't exist at the cwd (`Composer.tsx`,
 *   `src/lib/chat/store.ts` said from a sub-package's point of view) is
 *   looked up as a path SUFFIX in a cached listing of the cwd tree; a
 *   unique match wins, an ambiguous one stays `missing`.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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

// ---- extra safe roots (UNI-220, mirrors unipi-host's fs_scope.rs) ---------

/** The host's default extra roots; only existing ones count. */
export const DEFAULT_SAFE_ROOTS = ["/tmp", "/var/tmp", "/mnt", "/media", "/run/media/$USER", "/srv", "/opt"] as const;
const FORBIDDEN = ["/etc", "/usr", "/proc", "/sys", "/dev", "/boot", "/root", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/var", "/run", "/snap", "/lost+found"];

/** Whether `root` (absolute, real) may never be an extra root: `/`, system folders (inside or containing
 * one, except /var/tmp and /run/media/$USER), and other users' homes. Same rule as the host. */
export function forbiddenRoot(root: string, home: string, user: string): boolean {
  const r = resolvePath(root);
  if (r === "/") return true;
  if (inside(r, "/var/tmp") || inside(r, `/run/media/${user}`)) return false;
  if (FORBIDDEN.some((f) => inside(r, f) || inside(f, r))) return true;
  if (inside(r, home)) return false;
  return ["/home", "/Users"].some((h) => inside(r, h) || inside(h, r));
}

const realOr = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** Defaults + `allow` − `deny`, canonical, existing, never forbidden. */
export function resolveSafeRoots(config: { allow?: unknown; deny?: unknown }, home: string, user: string): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const expand = (p: string) => p.replace("$USER", user);
  const deny = list(config.deny).map((d) => realOr(expand(d)) ?? resolvePath(expand(d)));
  const out: string[] = [];
  for (const raw of [...DEFAULT_SAFE_ROOTS, ...list(config.allow)]) {
    const p = expand(raw);
    if (!p.startsWith("/")) continue;
    const real = realOr(p);
    if (!real || kindOf(real) !== "dir" || forbiddenRoot(real, home, user)) continue;
    if (deny.some((d) => inside(real, d)) || out.includes(real)) continue;
    out.push(real);
  }
  return out;
}

const hostConfigPath = () => join(process.env.UNIPI_HOST_DIR || join(homedir(), ".unipi", "app-host"), "config.json");
let rootsCache: { at: number; roots: string[]; deny: string[] } | undefined;

/** The host's extra roots + carve-outs, from its `config.json` (re-read at most every 5 s; unreadable = defaults). */
export function hostSafeRoots(now = Date.now(), home = homedir()): { roots: string[]; deny: string[] } {
  if (rootsCache && now - rootsCache.at < 5000) return rootsCache;
  let fs: { allow?: unknown; deny?: unknown } = {};
  try {
    const parsed = JSON.parse(readFileSync(hostConfigPath(), "utf8")) as { fs?: { allow?: unknown; deny?: unknown } };
    if (parsed && typeof parsed.fs === "object" && parsed.fs) fs = parsed.fs;
  } catch {
    // missing/unreadable: defaults
  }
  let user = process.env.USER || process.env.LOGNAME || "";
  if (!user) {
    try {
      user = userInfo().username;
    } catch {
      user = "";
    }
  }
  const deny = (Array.isArray(fs.deny) ? fs.deny : []).filter((d): d is string => typeof d === "string").map((d) => realOr(d) ?? resolvePath(d));
  rootsCache = { at: now, roots: resolveSafeRoots(fs, home, user), deny };
  return rootsCache;
}

/** Test hook. */
export function clearSafeRoots(): void {
  rootsCache = undefined;
}

/** Whether `abs` really (after symlinks) lies in an extra root and outside every carve-out. */
function inExtraRoot(abs: string, extra: { roots: readonly string[]; deny: readonly string[] }): boolean {
  if (!extra.roots.length) return false;
  const real = realOr(abs);
  if (!real) {
    // Not there (answers `missing` anyway); judge the spelling so we never say more than that.
    return false;
  }
  return extra.roots.some((r) => inside(real, r)) && !extra.deny.some((d) => inside(real, d));
}

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
 * when the cwd is $HOME or `/` (a tree that size says nothing useful about a bare `index.ts`).
 * `extra` defaults to the host's extra safe roots (UNI-220). */
export async function statPaths(
  paths: readonly string[],
  cwd: string,
  home = homedir(),
  extra: { roots: readonly string[]; deny: readonly string[] } = hostSafeRoots(Date.now(), home),
): Promise<PathStat[]> {
  const out: PathStat[] = [];
  const indexable = resolvePath(cwd) !== resolvePath(home) && resolvePath(cwd) !== "/";
  let idx: TreeIndex | undefined;
  for (const raw of paths.slice(0, PATHS_STAT_MAX)) {
    const path = String(raw).slice(0, PATH_MAX_CHARS);
    const resolved = resolveAgainst(path, cwd, home);
    if (!inside(resolved, cwd) && !inside(resolved, home) && !inExtraRoot(resolved, extra)) {
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
