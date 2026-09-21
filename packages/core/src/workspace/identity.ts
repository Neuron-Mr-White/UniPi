/**
 * Workspace identity — the single source of truth for "which project is this".
 *
 * Ported from maka's packages/storage/src/workspace-identity.ts (Apache-2.0),
 * adapted for unipi: a `.unipi-workspace.json` marker, synchronous IO (the
 * settings engine and most call sites are sync), and a `.gitignore`-append
 * side effect so the per-checkout id never travels through git.
 *
 * Contract:
 *   - realpath-canonicalize first, so symlinks and `..` never mint duplicates.
 *   - the marker is authoritative: once a workspace has an id it is NEVER
 *     rebound by path or inode. Moving/copying a repo keeps its id (the marker
 *     travels in the tree); a fresh checkout with no marker gets a new uuid.
 *   - all bulky state lives OUTSIDE the repo under ~/.unipi/workspace/<id>/,
 *     keyed by this id — see ./paths.ts.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

export const WORKSPACE_MARKER_FILE = ".unipi-workspace.json";
export const WORKSPACE_MARKER_SCHEMA_VERSION = 1 as const;
const MAX_WORKSPACE_MARKER_BYTES = 4_096;

export interface WorkspaceMarker {
  schemaVersion: typeof WORKSPACE_MARKER_SCHEMA_VERSION;
  workspaceId: string;
}

export interface WorkspaceIdentity {
  /** Stable uuid from the marker. The key for all per-workspace state. */
  workspaceId: string;
  /** realpath-resolved absolute workspace root. */
  canonicalPath: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isWorkspaceMarker(value: unknown): value is WorkspaceMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  const keys = Object.keys(m).sort();
  return (
    keys.length === 2 &&
    keys[0] === "schemaVersion" &&
    keys[1] === "workspaceId" &&
    m.schemaVersion === WORKSPACE_MARKER_SCHEMA_VERSION &&
    typeof m.workspaceId === "string" &&
    UUID_RE.test(m.workspaceId)
  );
}

function canonicalize(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    // Path may not exist yet (fresh cwd); fall back to a plain resolve so we
    // still produce a stable key rather than throwing at startup.
    return resolve(path);
  }
}

function readMarker(root: string): WorkspaceMarker | null {
  const markerPath = join(root, WORKSPACE_MARKER_FILE);
  try {
    const raw = readFileSync(markerPath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_WORKSPACE_MARKER_BYTES) return null;
    const parsed = JSON.parse(raw);
    return isWorkspaceMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeMarker(root: string, marker: WorkspaceMarker): void {
  const markerPath = join(root, WORKSPACE_MARKER_FILE);
  writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
}

/** Append the marker to .git/info/exclude so it never gets committed. */
function ensureMarkerIgnored(root: string): void {
  // Only bother when this tree is under git control.
  let inGit = false;
  let current = root;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      inGit = true;
      break;
    }
    const parent = parse(current).dir;
    if (parent === current) break;
    current = parent;
  }
  if (!inGit) return;

  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    const out = execFileSync(
      "git",
      ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { env, encoding: "utf8", timeout: 3_000, windowsHide: true },
    );
    const excludePath = out.trim();
    if (!isAbsolute(excludePath)) return;
    let contents = "";
    try {
      contents = readFileSync(excludePath, "utf8");
    } catch {
      // exclude file may not exist yet; appendFileSync creates it.
    }
    if (contents.split(/\r?\n/).includes(WORKSPACE_MARKER_FILE)) return;
    const sep = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
    appendFileSync(excludePath, `${sep}${WORKSPACE_MARKER_FILE}\n`, { mode: 0o600 });
  } catch {
    // Best-effort: a missing/locked git is never fatal to identity resolution.
  }
}

const cache = new Map<string, WorkspaceIdentity>();

/**
 * Resolve (and, on first touch, create) the workspace identity for a cwd.
 * Cached per canonical path for the life of the process.
 */
export function resolveWorkspaceIdentity(cwd: string = process.cwd()): WorkspaceIdentity {
  const canonicalPath = canonicalize(cwd);
  const cached = cache.get(canonicalPath);
  if (cached) return cached;

  let marker = readMarker(canonicalPath);
  if (!marker) {
    marker = { schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION, workspaceId: randomUUID() };
    try {
      if (!existsSync(canonicalPath)) mkdirSync(canonicalPath, { recursive: true });
      writeMarker(canonicalPath, marker);
      ensureMarkerIgnored(canonicalPath);
    } catch {
      // If we cannot persist the marker (read-only fs), still return a stable
      // id for this process so state has somewhere to go.
    }
  } else {
    ensureMarkerIgnored(canonicalPath);
  }

  const identity: WorkspaceIdentity = { workspaceId: marker.workspaceId, canonicalPath };
  cache.set(canonicalPath, identity);
  return identity;
}

/** Short form of the id for readable dir names / session ids. */
export function workspaceId(cwd: string = process.cwd()): string {
  return resolveWorkspaceIdentity(cwd).workspaceId;
}

/** Test seam: forget cached identities. */
export function resetWorkspaceCache(): void {
  cache.clear();
}
