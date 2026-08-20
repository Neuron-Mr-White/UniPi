/**
 * @unipi/memory — Storage layer
 *
 * Backend: MemPalace (auto-installed via uv, auto-migrated from
 * legacy SQLite/markdown data on first run). Markdown files remain the
 * durable human-readable tier and the migration source.
 */

import * as yaml from "js-yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import {
  ensureMempalace,
  runBridge,
  runBridgeAsync,
  isMigrated,
  markMigrated,
  getMemorySourceFingerprint,
  isPingVerified,
  markPingVerified,
  invalidatePingVerified,
  DEFAULT_PALACE,
  type MempalaceInstall,
  type MempalaceRecord,
  type MempalaceSearchResult,
  type MempalaceListItem,
  type MempalaceListItemAll,
  type MigrationResult,
} from "./mempalace.js";


/** Convert a MemPalace record (plain JSON) into a MemoryRecord. */
function toMemoryRecord(r: MempalaceRecord): MemoryRecord {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    tags: Array.isArray(r.tags) ? r.tags : [],
    project: r.project,
    type: (r.type as MemoryRecord["type"]) || "summary",
    created: r.created || "",
    updated: r.updated || "",
    embedding: null,
  };
}

/** Memory record interface */
export interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  project: string;
  type: "preference" | "decision" | "pattern" | "summary";
  created: string;
  updated: string;
  embedding?: Float32Array | null;
}

/** Search result with snippet */
export interface SearchResult {
  record: MemoryRecord;
  score: number;
  snippet: string;
}

/** Memory file frontmatter */
interface MemoryFrontmatter {
  id?: string;
  title: string;
  tags: string[];
  project: string;
  created: string;
  updated: string;
  type: string;
}

/**
 * Get the base memory directory (~/.unipi/memory/)
 */
export function getMemoryBaseDir(): string {
  return path.join(os.homedir(), ".unipi", "memory");
}

/**
 * Get the project memory directory
 */
export function getProjectDir(projectName: string): string {
  return path.join(getMemoryBaseDir(), projectName);
}

/**
 * Get all project directories under memory base.
 */
export function getAllProjectDirs(): Array<{ name: string; dir: string }> {
  const base = getMemoryBaseDir();
  if (!fs.existsSync(base)) return [];
  
  return fs.readdirSync(base)
    .filter(f => {
      const fullPath = path.join(base, f);
      return fs.statSync(fullPath).isDirectory();
    })
    .map(name => ({
      name,
      dir: path.join(base, name),
    }));
}

/**
 * Sanitize a path to create a project name.
 * Replace non-alphanumeric chars with _, collapse repeats.
 */
export function sanitizeProjectName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_");
}

/**
 * Get the project name from the current working directory.
 * Uses the last meaningful directory segment.
 */
export function getProjectName(cwd: string): string {
  // Use the last directory name as the project name
  const base = path.basename(cwd);
  return sanitizeProjectName(base);
}

/**
 * Parse a memory markdown file with YAML frontmatter.
 */
export function parseMemoryFile(filePath: string): MemoryRecord | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseMemoryContent(content);
  } catch {
    return null;
  }
}

/**
 * Parse memory content (markdown with frontmatter).
 */
export function parseMemoryContent(content: string): MemoryRecord | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const [, frontmatterStr, body] = match;
  const frontmatter = yaml.load(frontmatterStr) as MemoryFrontmatter;

  return {
    id: frontmatter.id || "",
    title: frontmatter.title,
    content: body.trim(),
    tags: frontmatter.tags || [],
    project: frontmatter.project,
    type: (frontmatter.type as MemoryRecord["type"]) || "summary",
    created: frontmatter.created,
    updated: frontmatter.updated,
  };
}

/**
 * Write a memory record to a markdown file.
 */
export function writeMemoryFile(filePath: string, record: MemoryRecord): void {
  const frontmatter: MemoryFrontmatter = {
    id: record.id,
    title: record.title,
    tags: record.tags,
    project: record.project,
    created: record.created,
    updated: record.updated,
    type: record.type,
  };

  const content = `---
${yaml.dump(frontmatter, { lineWidth: -1 })}---

${record.content}
`;

  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * MemoryStorage class — manages SQLite + markdown storage for a single project.
 */
export class MemoryStorage {
  private projectName: string;
  private scopeDir: string;
  private mempalaceInstall: MempalaceInstall | null = null;
  private palacePath: string = DEFAULT_PALACE;

  constructor(projectName: string) {
    this.projectName = projectName;
    this.scopeDir = getProjectDir(projectName);
  }

  /** True when the MemPalace backend is active for this instance. */
  isMempalace(): boolean {
    return this.mempalaceInstall !== null;
  }

  /**
   * Run a MemPalace bridge command, invalidating the ping-verified flag
   * when the call fails. This ensures a palace that breaks after the
   * startup ping-skip gets re-verified on the next session.
   */
  private memPalaceCall<T>(cmd: string, args: Record<string, unknown> = {}): T | null {
    const install = this.mempalaceInstall;
    if (!install) return null;
    const result = runBridge<T>(install, this.palacePath, cmd, args);
    if (result === null) {
      // Backend didn't respond — force a real ping next session.
      invalidatePingVerified();
    }
    return result;
  }

  /** Async twin of memPalaceCall, for paths that must not block the UI. */
  private async memPalaceCallAsync<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
    const install = this.mempalaceInstall;
    if (!install) return null;
    const result = await runBridgeAsync<T>(install, this.palacePath, cmd, args);
    if (result === null) {
      invalidatePingVerified();
    }
    return result;
  }

  /**
   * Async twin of listAll().
   *
   * The SQLite path is already fast and stays synchronous; only the MemPalace
   * path (a Python spawn) actually needs to yield.
   */
  async listAllAsync(): Promise<Array<{ id: string; title: string; type: string }>> {
    return (await this.memPalaceCallAsync<MempalaceListItem[]>("list", {
      wing: this.projectName,
    })) ?? [];
  }

  /**
   * Initialize storage. Tries MemPalace first (auto-install + one-way
   * auto-migration of legacy memories). Throws if MemPalace is unavailable.
   */
  init(): void {
    if (!fs.existsSync(this.scopeDir)) {
      fs.mkdirSync(this.scopeDir, { recursive: true });
    }

    if (!this.tryInitMempalace()) {
      throw new Error("MemPalace backend unavailable. Ensure uv is installed.");
    }
  }

  /**
   * Attempt to initialize the MemPalace backend. Returns true on success.
   * Handles auto-install and one-way auto-migration of legacy memories.
   * Never throws — any failure returns false so init() can throw a clear error.
   */
  private tryInitMempalace(): boolean {
    let install: MempalaceInstall | null;
    try {
      install = ensureMempalace();
    } catch {
      return false;
    }
    if (!install) return false;

    // Sanity ping — if the palace/bridge is broken, fall back.
    // Skip the ~0.5s Python cold-start when we ping-verified recently;
    // the flag is invalidated on any backend failure so a broken palace
    // is re-checked on the next session.
    if (!isPingVerified()) {
      const ok = runBridge<string>(install, this.palacePath, "ping");
      if (ok !== "pong") return false;
      markPingVerified();
    }

    this.mempalaceInstall = install;

    // Idempotent migration + automatic catch-up. The source fingerprint turns
    // the old one-shot timestamp into a resumable state: new/changed markdown
    // or SQLite sources trigger another verified upsert pass. Never mark a
    // failed/partial run complete; it will retry on a later session.
    const sourceFingerprint = getMemorySourceFingerprint(getMemoryBaseDir());
    if (!isMigrated(sourceFingerprint)) {
      try {
        // First migrations can embed thousands of records. Give the bridge a
        // practical bounded window rather than the normal per-operation 60s.
        const result = runBridge<MigrationResult>(install, this.palacePath, "migrate", {
          source_dir: getMemoryBaseDir(),
        }, 15 * 60_000);
        if (
          result &&
          result.failed === 0 &&
          result.verified === result.discovered
        ) {
          markMigrated(sourceFingerprint, result);
        }
      } catch {
        // Palace remains available for current writes; durable markdown/SQLite
        // sources are untouched and migration retries because no state is set.
      }
    }

    return true;
  }


  /**
   * Close the database connection.
   */
  close(): void {
    // MemPalace is processless; nothing to close.
  }

  /**
   * Store or update a memory record.
   * Uses transaction to ensure atomicity — either all writes succeed or none do.
   */
  store(record: MemoryRecord): void {
    // Generate ID from title if not provided
    if (!record.id) {
      record.id = record.title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    }

    // Set timestamps
    const now = new Date().toISOString();
    if (!record.created) record.created = now;
    record.updated = now;

    // Set project if not provided
    if (!record.project) record.project = this.projectName;

    this.storeMempalace(record);
    return;
  }

  /**
   * Store a record via the MemPalace backend. Also writes the markdown
   * tier so the human-readable file and legacy migration source stay
   * consistent and durable as a fallback source.
   */
  private storeMempalace(record: MemoryRecord): void {
    this.memPalaceCall("store", {
      record: {
        id: record.id,
        title: record.title,
        content: record.content,
        tags: record.tags,
        project: record.project,
        type: record.type,
        created: record.created,
        updated: record.updated,
        source_kind: "markdown",
      },
    });
    // Markdown tier (durable human copy + fallback source).
    try {
      const mdPath = path.join(this.scopeDir, `${record.id}.md`);
      const dir = path.dirname(mdPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      writeMemoryFile(mdPath, record);
    } catch {
      // Palace write succeeded; markdown is best-effort.
    }
  }

  /**
   * Sync orphaned markdown files into the database.
   * Reads all .md files in the project dir, parses frontmatter,
   * and inserts any that are missing from the DB.
   * Returns count of synced files.
   */
  syncOrphanedFiles(): number {
    const synced = this.memPalaceCall<number>("sync_orphaned", {
      project_dir: this.scopeDir,
      wing: this.projectName,
    });
    return synced ?? 0;
  }

  /**
   * Find memories with similar titles (fuzzy match).
   * Returns array of { record, similarity } sorted by similarity desc.
   */
  findSimilarByTitle(title: string, threshold = 0.6): Array<{ record: MemoryRecord; similarity: number }> {
    const rows = this.memPalaceCall<Array<{ record: MempalaceRecord; similarity: number }>>(
      "find_similar",
      { wing: this.projectName, title, threshold },
    ) ?? [];
    return rows.map((r) => ({ record: toMemoryRecord(r.record), similarity: r.similarity }));
  }

  /**
   * Get a memory record by ID.
   */
  getById(id: string): MemoryRecord | null {
    const rec = this.memPalaceCall<MempalaceRecord | null>("get", { id });
    return rec ? toMemoryRecord(rec) : null;
  }

  /**
   * Get a memory record by title (fuzzy match).
   */
  getByTitle(title: string): MemoryRecord | null {
    const rec = this.memPalaceCall<MempalaceRecord | null>("get_by_title", {
      wing: this.projectName,
      title,
    });
    return rec ? toMemoryRecord(rec) : null;
  }

  /**
   * List all memories (titles only).
   */
  listAll(): Array<{ id: string; title: string; type: string }> {
    const items = this.memPalaceCall<MempalaceListItem[]>("list", {
      wing: this.projectName,
    }) ?? [];
    return items;
  }

  /**
   * Delete a memory by ID.
   */
  delete(id: string): boolean {
    const ok = this.memPalaceCall<boolean>("delete", { id }) ?? false;
    // Also remove the markdown tier if present.
    try {
      const mdPath = path.join(this.scopeDir, `${id}.md`);
      if (fs.existsSync(mdPath)) fs.unlinkSync(mdPath);
    } catch { /* ignore */ }
    return ok;
  }

  /**
   * Delete a memory by title.
   */
  deleteByTitle(title: string): boolean {
    const record = this.getByTitle(title);
    if (!record) return false;
    return this.delete(record.id);
  }

  /**
   * Search memories using hybrid approach.
   */
  search(query: string, limit = 10, embedding?: Float32Array | null): SearchResult[] {
    const rows = this.memPalaceCall<MempalaceSearchResult[]>("search", {
      query,
      wing: this.projectName,
      limit,
    }) ?? [];
    return rows.map((r) => ({
      record: toMemoryRecord(r),
      score: r.score,
      snippet: r.snippet,
    }));
  }

}

/**
 * Search across ALL project directories.
 * Returns results with project name prefix.
 */
export function searchAllProjects(
  query: string,
  limit = 10
): SearchResult[] {
  // MemPalace global path: query across all wings in one call.
  const install = ensureMempalace();
  if (install) {
    const rows = runBridge<MempalaceSearchResult[]>(install, DEFAULT_PALACE, "search", {
      query,
      limit,
    }) ?? [];
    return rows.map((r) => ({
      record: toMemoryRecord(r),
      score: r.score,
      snippet: r.snippet,
    }));
  }


  return [];
}

/** Result shape shared by listAllProjects and its cached wrapper. */
type AllProjectsEntry = { project: string; id: string; title: string; type: string };

/**
 * Cached view of listAllProjects().
 *
 * The uncached call spawns a Python MemPalace bridge (~1.1s). It backs two
 * display-only counters in the info overlay, so a slightly stale number is
 * strictly better than a 1.1s stall on every startup.
 */
let allProjectsCache: { at: number; value: AllProjectsEntry[] } | null = null;

/** How long a cached cross-project listing stays valid. */
const ALL_PROJECTS_TTL_MS = 60_000;

/** Drop the cached cross-project listing (call after storing/deleting). */
export function invalidateAllProjectsCache(): void {
  allProjectsCache = null;
}

/**
 * Async twin of listAllProjectsCached(), for UI paths.
 *
 * On a cache miss the MemPalace path spawns Python; doing that synchronously
 * froze the UI for ~1.1s. Only the bridge call is async — the SQLite fallback
 * is async.
 */
export async function listAllProjectsCachedAsync(): Promise<AllProjectsEntry[]> {
  const now = Date.now();
  if (allProjectsCache && now - allProjectsCache.at < ALL_PROJECTS_TTL_MS) {
    return allProjectsCache.value;
  }

  const install = ensureMempalace();
  if (!install) return [];
  const items = (await runBridgeAsync<MempalaceListItemAll[]>(install, DEFAULT_PALACE, "list_all", {})) ?? [];
  const value = items.map((m) => ({ project: m.project, id: m.id, title: m.title, type: m.type }));

  allProjectsCache = { at: now, value };
  return value;
}

/**
 * List memories from ALL projects.
 * Returns memories with project name prefix.
 */
export function listAllProjects(): AllProjectsEntry[] {
  // MemPalace global path: list all drawers across wings.
  const install = ensureMempalace();
  if (install) {
    const items = runBridge<MempalaceListItemAll[]>(install, DEFAULT_PALACE, "list_all", {}) ?? [];
    return items.map((m) => ({
      project: m.project,
      id: m.id,
      title: m.title,
      type: m.type,
    }));
  }


  return [];
}

