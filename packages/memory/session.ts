/**
 * @unipi/memory — Session wiring
 *
 * Per-session memory backend. Writes: daemon job when one is reachable
 * (auto-start only when the autoStartDaemon switch is on), otherwise the
 * direct CLI path — `mempalace mine` for stores, a one-shot write-mode MCP
 * server for deletes — exactly like upstream's "prefer" routing. Reads: one
 * warm read-only MCP reader; markdown-only mode (no/old MemPalace) answers
 * search/list straight from the local md files.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_PALACE,
  ensureMempalace,
  probeDaemon,
  compareVersions,
  detectVersion,
  writeCachedInstall,
  type MempalaceInstall,
} from "./mempalace.js";
import {
  MIN_MEMPALACE,
  deleteThroughDaemon,
  deleteViaWriteMcp,
  fileThroughDaemon,
  mineDirect,
  wakeUp,
  type StoreOutcome,
  type WriteOutcome,
} from "./daemon.js";
import { MemoryReader } from "./reader.js";
import { enqueuePending, pendingCount } from "./pending.js";
import {
  ensureMempalaceYaml,
  parseMemoryContent,
  parseMemoryFile,
  scanProjectMemories,
  writeMemoryFile,
  type MemoryRecord,
} from "./files.js";
import {
  memoryFilePath,
  memoryRoot,
  projectDir,
  projectName,
  sanitizeProjectName,
  type MemoryType,
} from "./paths.js";

export interface StoreResult extends StoreOutcome {
  record: MemoryRecord;
}

export interface SearchHit {
  title: string;
  wing: string;
  room: string;
  score: number;
  snippet: string;
  sourceFile?: string;
  addedBy?: string;
  /** "pi" when the memory lives under ~/.unipi/memory (or was written by the
   *  v2 bridge), "local" for markdown-only hits, else the raw added_by. */
  sourceLabel: string;
  isPiMemory: boolean;
}

export interface SessionBackend {
  install: MempalaceInstall | null;
  reader: MemoryReader | null;
  project: string;
  /** "palace" = MemPalace ≥ MIN with reader; "local" = markdown-only mode. */
  mode: "palace" | "local";
  /** Why palace mode is unavailable — rendered on the session card/status. */
  installIssue?: string;
  store(record: Omit<MemoryRecord, "project" | "created" | "updated" | "id"> & { id?: string }): Promise<StoreResult>;
  delete(project: string, id: string): Promise<{ outcome: WriteOutcome; found: boolean }>;
  search(query: string, limit: number, scope: "all" | "project"): Promise<SearchHit[]>;
  list(project?: string): Promise<{ project: string; id: string; title: string; type: string }[]>;
  /** Project md files (the local truth for the store peek + counts). */
  localMemories(project?: string): MemoryRecord[];
  pending(): number;
  daemonReachable(): Promise<boolean>;
  wakeUpText(): Promise<string | null>;
  close(): void;
}

/** MD files written by pi live under ~/.unipi/memory — everything else is a foreign drawer. */
function isPiSource(sourceFile: string | undefined): boolean {
  if (!sourceFile) return false;
  if (sourceFile.startsWith("unipi://memory/")) return true; // v2 bridge records
  const normalized = path.normalize(sourceFile);
  return normalized.startsWith(path.normalize(memoryRoot()) + path.sep);
}

/** Decode one path part of a unipi:// URI — the bridge's quote_uri_part
 *  writes %XX of the raw byte for non-ascii too, so use decodeURIComponent
 *  on the common case and fall back to latin1-safe manual decode. */
function decodeUriPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) =>
      String.fromCodePoint(parseInt(h, 16)));
  }
}

/** "unipi://memory/<p>/<id>" → {project, id} or null. */
function parseLegacySource(sourceFile: string): { project: string; id: string } | null {
  const m = sourceFile.match(/^unipi:\/\/memory\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  return { project: decodeUriPart(m[1]), id: decodeUriPart(m[2]) };
}

function titleFromMdOrFile(sourceFile: string | undefined, docText: string, fallback: string): { title: string; type?: MemoryType; tags?: string[] } {
  if (sourceFile) {
    const legacy = parseLegacySource(sourceFile);
    if (legacy) {
      // v2 bridge drawer: the doc embeds frontmatter — prefer its title,
      // else the (decoded) id.
      const parsed = parseMemoryContent(docText);
      if (parsed?.title) return { title: parsed.title, type: parsed.type, tags: parsed.tags };
      return { title: legacy.id || fallback };
    }
    const abs = path.normalize(sourceFile);
    if (isPiSource(abs)) {
      const rec = parseMemoryFile(abs);
      if (rec) return { title: rec.title, type: rec.type, tags: rec.tags };
    }
    return { title: path.basename(abs).replace(/\.md$/i, "") || fallback };
  }
  return { title: fallback };
}

function snippet(text: string | undefined, max = 160): string {
  const clean = (text ?? "").replace(/^---\s*\n[\s\S]*?\n---\s*/m, "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function sourceLabelOf(pi: boolean, addedBy: string): string {
  if (pi) return "pi";
  switch (addedBy) {
    case "unipi":
    case "unipi-memory-bridge":
      return "pi";
    default:
      return addedBy || "mempalace";
  }
}

/** Pure: group raw reader hits by source_file (best score), map titles/labels. Exported for tests. */
export function groupSearchHits(raw: Array<{
  drawer_id: string;
  text?: string;
  content?: string;
  score?: number;
  similarity?: number;
  wing?: string;
  room?: string;
  source_file?: string;
  source_path?: string;
  added_by?: string;
  metadata?: Record<string, unknown>;
}>, limit: number): SearchHit[] {
  const grouped = new Map<string, SearchHit>();
  for (const hit of raw) {
    const meta = (hit.metadata ?? {}) as Record<string, unknown>;
    // The MCP search response is flat: source_path carries the absolute path,
    // source_file only the basename. Chroma metadata uses source_file=abs.
    const src = hit.source_path ?? hit.source_file ?? meta.source_file;
    const sourceFile = typeof src === "string" ? src : undefined;
    const key = sourceFile ?? hit.drawer_id;
    const score = typeof hit.score === "number" ? hit.score
      : typeof hit.similarity === "number" ? hit.similarity : 0;
    const pi = isPiSource(sourceFile);
    const docText = hit.content ?? hit.text ?? "";
    const named = titleFromMdOrFile(sourceFile, docText, key);
    const legacy = sourceFile ? parseLegacySource(sourceFile) : null;
    const room = typeof meta.room === "string" ? meta.room : hit.room ?? "";
    const wingName = legacy?.project
      ?? (typeof meta.wing === "string" ? meta.wing : hit.wing ?? "");
    const addedBy = typeof meta.added_by === "string" ? meta.added_by : hit.added_by ?? "";
    const hit2: SearchHit = {
      title: named.title,
      wing: wingName,
      room,
      score,
      snippet: snippet(docText),
      sourceFile,
      addedBy,
      sourceLabel: sourceLabelOf(pi, addedBy),
      isPiMemory: pi,
    };
    const existing = grouped.get(key);
    if (!existing || hit2.score > existing.score) grouped.set(key, hit2);
  }
  return [...grouped.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Term-overlap scoring over local md files — the markdown-only search path. */
export function localSearch(
  query: string,
  limit: number,
  scope: "all" | "project",
  project: string,
): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const root = memoryRoot();
  // Project scope honors case-variant dirs (pre-migration EnvStripper/…).
  const allDirs = fs.existsSync(root)
    ? fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
    : [];
  const dirs = scope === "project"
    ? allDirs.filter((n) => n === project || sanitizeProjectName(n) === project)
    : allDirs;

  const scored: SearchHit[] = [];
  const walk = (dir: string, proj: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, proj); continue; }
      if (!e.name.endsWith(".md")) continue;
      const rec = parseMemoryFile(p);
      if (!rec) continue;
      const hay = `${rec.title} ${rec.tags.join(" ")} ${rec.content}`.toLowerCase();
      const hits = terms.filter((t) => hay.includes(t)).length;
      if (!hits) continue;
      scored.push({
        title: rec.title,
        wing: proj,
        room: rec.type,
        score: hits / terms.length,
        snippet: snippet(rec.content),
        sourceFile: p,
        sourceLabel: "local",
        isPiMemory: true,
      });
    }
  };
  for (const name of dirs) {
    const dir = path.join(root, name);
    if (!fs.existsSync(dir)) continue;
    try { walk(dir, name); } catch { /* unreadable */ }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function createSessionBackend(cwd: string): SessionBackend {
  const install = ensureMempalace();
  const project = projectName(cwd);
  // Version gate: < MIN can't serve the reader or the mine files payload —
  // degrade to markdown-only for the session. The cache may be stale (a uv
  // upgrade between sessions) — re-detect before deciding.
  if (install && compareVersions(install.version, MIN_MEMPALACE) < 0) {
    const fresh = detectVersion(install.python);
    if (fresh !== install.version) {
      install.version = fresh;
      writeCachedInstall(install);
    }
  }
  const versionOk = !!install && compareVersions(install.version, MIN_MEMPALACE) >= 0;
  const installIssue = !install
    ? "MemPalace isn't installed — install uv (https://docs.astral.sh/uv/) for semantic search"
    : !versionOk
      ? `MemPalace ${install.version} is too old — run \`uv tool upgrade mempalace\` for semantic search`
      : undefined;
  const mode: "palace" | "local" = versionOk ? "palace" : "local";
  const reader = versionOk && install ? new MemoryReader(install, DEFAULT_PALACE) : null;
  if (reader) void reader.start(); // warm up without blocking session_start

  /** Write the record via the best available path; journal what didn't land. */
  const storeRecord = async (rec: MemoryRecord): Promise<StoreOutcome> => {
    ensureMempalaceYaml(rec.project);
    const mdPath = writeMemoryFile(rec);
    if (!install || mode === "local") {
      enqueuePending({ kind: "store", file: mdPath, project: rec.project, id: rec.id, enqueuedAt: new Date().toISOString() });
      return { outcome: "markdown-only", error: installIssue ?? "mempalace not installed" };
    }
    // Type moves carry a stale source_file for the old drawer — delete it.
    const oldFiles = scanProjectMemories(rec.project).filter(
      (m) => m.id === rec.id && m.filePath && m.filePath !== mdPath,
    );
    const out = await fileThroughDaemon(install, projectDir(rec.project), [mdPath], rec.project, DEFAULT_PALACE, 10_000);
    // Stale old-type file/drawer cleanup runs on every path — same
    // daemon → write-MCP → journal chain as delete().
    for (const stale of oldFiles) {
      if (!stale.filePath) continue;
      const del = await deleteThroughDaemon(install, stale.filePath, DEFAULT_PALACE, 10_000);
      try { fs.unlinkSync(stale.filePath); } catch { /* keep */ }
      if (del.outcome === "filed" || del.outcome === "queued") continue;
      const direct = await deleteViaWriteMcp(install, stale.filePath, DEFAULT_PALACE);
      if (!direct.ok) {
        enqueuePending({
          kind: "delete", file: stale.filePath, project: rec.project, id: rec.id,
          enqueuedAt: new Date().toISOString(), heldBy: direct.heldBy,
        });
      }
    }
    if (out.outcome === "filed" || out.outcome === "queued") return out;
    // No daemon (or a refused job) — upstream "prefer" fallback: plain
    // `mempalace mine`, the user's write_routing decides.
    const direct = await mineDirect(install, projectDir(rec.project), rec.project, DEFAULT_PALACE);
    if (direct.ok) return { outcome: "filed" };
    enqueuePending({
      kind: "store", file: mdPath, project: rec.project, id: rec.id,
      enqueuedAt: new Date().toISOString(), heldBy: direct.heldBy,
    });
    return { outcome: "markdown-only", error: direct.error ?? out.error };
  };

  return {
    install,
    reader,
    project,
    mode,
    installIssue,
    localMemories: (p) => scanProjectMemories(p ?? project),
    pending: pendingCount,
    daemonReachable: async () => install ? (await probeDaemon(DEFAULT_PALACE)).reachable : false,

    async store(input) {
      const now = new Date().toISOString();
      const rec: MemoryRecord = {
        ...input,
        id: input.id || input.title.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        project,
        created: now,
        updated: now,
      };
      const outcome = await storeRecord(rec);
      return { ...outcome, record: rec };
    },

    async delete(p, id) {
      const local = scanProjectMemories(p).find((m) => m.id === id || m.title === id);
      const mdPath = local?.filePath ?? memoryFilePath(p, local?.type ?? "summary", id);
      if (mdPath && fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
      if (!install || mode === "local") {
        enqueuePending({ kind: "delete", file: mdPath, project: p, id, enqueuedAt: new Date().toISOString() });
        return { outcome: "markdown-only", found: !!local };
      }
      const res = await deleteThroughDaemon(install, mdPath, DEFAULT_PALACE, 10_000);
      if (res.outcome === "filed" || res.outcome === "queued") {
        return { outcome: res.outcome, found: !!local };
      }
      // No daemon — one-shot write-mode MCP server takes the lease briefly.
      const direct = await deleteViaWriteMcp(install, mdPath, DEFAULT_PALACE);
      if (direct.ok) return { outcome: "filed", found: !!local };
      enqueuePending({
        kind: "delete", file: mdPath, project: p, id,
        enqueuedAt: new Date().toISOString(), heldBy: direct.heldBy,
      });
      return { outcome: "markdown-only", found: !!local };
    },

    async search(query, limit, scope) {
      if (mode === "local" || !reader) {
        return localSearch(query, limit, scope, project);
      }
      const wing = scope === "project" ? project : undefined;
      const raw = await reader.search(query, Math.max(limit * 3, 10), wing);
      return groupSearchHits(raw, limit);
    },

    async list(p) {
      const local = scanProjectMemories(p ?? project)
        .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""))
        .map((m) => ({ project: p ?? project, id: m.id, title: m.title, type: m.type }));
      return local;
    },

    async wakeUpText() {
      if (!install || mode === "local") return null;
      return wakeUp(install, project, DEFAULT_PALACE);
    },

    close() {
      reader?.kill();
    },
  };
}
