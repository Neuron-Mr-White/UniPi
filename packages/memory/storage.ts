/**
 * @unipi/memory — Storage layer
 *
 * Two-tier storage: SQLite + sqlite-vec for vector search,
 * markdown files for human-readable memory.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import * as yaml from "js-yaml";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

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
  title: string;
  tags: string[];
  project: string;
  created: string;
  updated: string;
  type: string;
}

const MEMORY_DB_NAME = "memory.db";
const MEMORY_EMBEDDING_DIM = 384;

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
    id: "",
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
  private db: Database.Database | null = null;
  private projectName: string;
  private scopeDir: string;

  constructor(projectName: string) {
    this.projectName = projectName;
    this.scopeDir = getProjectDir(projectName);
  }

  /**
   * Initialize the storage (create DB, tables, load extension).
   *
   * Uses retry logic to handle concurrent access from multiple Pi sessions,
   * especially on WSL/Windows filesystem where SQLite locking can be flaky.
   *
   * IMPORTANT: We never delete the DB here — another session may have it open.
   * If all retries fail, we throw and let this session run without memory.
   */
  init(): void {
    // Ensure directory exists
    if (!fs.existsSync(this.scopeDir)) {
      fs.mkdirSync(this.scopeDir, { recursive: true });
    }

    const dbPath = path.join(this.scopeDir, MEMORY_DB_NAME);
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.initDb(dbPath);
        return; // Success
      } catch (err: any) {
        const isTransient =
          err?.message?.includes("disk I/O error") ||
          err?.code === "SQLITE_IOERR" ||
          err?.code === "SQLITE_BUSY" ||
          err?.message?.includes("database is locked");

        this.close();

        if (isTransient && attempt < maxRetries) {
          // Likely concurrent access — back off and retry.
          // Do NOT delete the DB: another session may have it open
          // and deleting open files on WSL/Windows is unsafe.
          const delayMs = 50 * Math.pow(2, attempt - 1); // 50, 100, 200, 400
          console.warn(
            `[unipi/memory] Transient error on attempt ${attempt}/${maxRetries}, retrying in ${delayMs}ms...`
          );
          const end = Date.now() + delayMs;
          while (Date.now() < end) { /* busy wait */ }
          continue;
        }

        // Either non-transient error, or retries exhausted.
        // Log and throw — this session will run without memory.
        if (isTransient) {
          console.warn(
            "[unipi/memory] Could not open database after retries. " +
            "Another session may have the DB locked. Memory unavailable this session."
          );
        }
        throw err;
      }
    }
  }

  /**
   * Open database and set up schema. Called by init() with retry logic.
   */
  private initDb(dbPath: string): void {
    this.db = new Database(dbPath, { timeout: 5000 });

    // Enable WAL mode for concurrent reads
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    // Load sqlite-vec extension
    try {
      sqliteVec.load(this.db);
    } catch (err) {
      console.warn("[unipi/memory] Failed to load sqlite-vec, fuzzy-only mode:", err);
    }

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        project TEXT,
        type TEXT,
        created TEXT,
        updated TEXT,
        embedding BLOB
      )
    `);

    // Create vector table if sqlite-vec loaded
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(embedding float[${MEMORY_EMBEDDING_DIM}])
      `);
    } catch {
      // vec0 table may already exist or sqlite-vec not loaded
    }

    // Verify database is usable
    this.db.prepare("SELECT 1 FROM memories LIMIT 0").get();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Remove corrupted database files (db, wal, shm).
   */
  private removeCorruptedDb(): void {
    const dbPath = path.join(this.scopeDir, MEMORY_DB_NAME);
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    for (const file of files) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          console.warn(`[unipi/memory] Removed corrupted file: ${file}`);
        }
      } catch {
        // Ignore removal errors
      }
    }
  }

  /**
   * Check if database is healthy.
   */
  isHealthy(): boolean {
    if (!this.db) return false;
    try {
      this.db.prepare("SELECT 1").get();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store or update a memory record.
   */
  store(record: MemoryRecord): void {
    if (!this.db) throw new Error("Storage not initialized");

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

    // Upsert into memories table
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memories (id, title, content, tags, project, type, created, updated, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tagsJson = JSON.stringify(record.tags);
    const embeddingBuf = record.embedding ? Buffer.from(record.embedding.buffer) : null;

    stmt.run(
      record.id,
      record.title,
      record.content,
      tagsJson,
      record.project,
      record.type,
      record.created,
      record.updated,
      embeddingBuf
    );

    // Update vector table
    if (record.embedding) {
      try {
        // Delete old vector if exists
        this.db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(this.idToRowid(record.id)));
      } catch {
        // Ignore if not found
      }

      try {
        const vecStmt = this.db.prepare(
          "INSERT INTO memories_vec(rowid, embedding) VALUES (?, ?)"
        );
        vecStmt.run(
          BigInt(this.idToRowid(record.id)),
          Buffer.from(record.embedding.buffer)
        );
      } catch (err) {
        console.warn("[unipi/memory] Failed to insert vector:", err);
      }
    }

    // Write markdown file
    const mdPath = path.join(this.scopeDir, `${record.id}.md`);
    writeMemoryFile(mdPath, record);
  }

  /**
   * Get a memory record by ID.
   */
  getById(id: string): MemoryRecord | null {
    if (!this.db) throw new Error("Storage not initialized");

    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as any;
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags || "[]"),
      project: row.project,
      type: row.type,
      created: row.created,
      updated: row.updated,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer) : null,
    };
  }

  /**
   * Get a memory record by title (fuzzy match).
   */
  getByTitle(title: string): MemoryRecord | null {
    if (!this.db) throw new Error("Storage not initialized");

    // Try exact match first
    const exact = this.db.prepare("SELECT * FROM memories WHERE title = ?").get(title) as any;
    if (exact) {
      return {
        id: exact.id,
        title: exact.title,
        content: exact.content,
        tags: JSON.parse(exact.tags || "[]"),
        project: exact.project,
        type: exact.type,
        created: exact.created,
        updated: exact.updated,
        embedding: exact.embedding ? new Float32Array(exact.embedding.buffer) : null,
      };
    }

    // Try case-insensitive match
    const row = this.db.prepare("SELECT * FROM memories WHERE LOWER(title) = LOWER(?)").get(title) as any;
    if (!row) return null;

    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: JSON.parse(row.tags || "[]"),
      project: row.project,
      type: row.type,
      created: row.created,
      updated: row.updated,
      embedding: row.embedding ? new Float32Array(row.embedding.buffer) : null,
    };
  }

  /**
   * List all memories (titles only).
   */
  listAll(): Array<{ id: string; title: string; type: string }> {
    if (!this.db) throw new Error("Storage not initialized");

    const rows = this.db.prepare("SELECT id, title, type FROM memories ORDER BY updated DESC").all() as any[];
    return rows.map((r) => ({ id: r.id, title: r.title, type: r.type }));
  }

  /**
   * Delete a memory by ID.
   */
  delete(id: string): boolean {
    if (!this.db) throw new Error("Storage not initialized");

    // Delete from vector table
    try {
      this.db.prepare("DELETE FROM memories_vec WHERE rowid = ?").run(BigInt(this.idToRowid(id)));
    } catch {
      // Ignore
    }

    // Delete from memories table
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);

    // Delete markdown file
    const mdPath = path.join(this.scopeDir, `${id}.md`);
    try {
      if (fs.existsSync(mdPath)) {
        fs.unlinkSync(mdPath);
      }
    } catch {
      // Ignore
    }

    return result.changes > 0;
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
    if (!this.db) throw new Error("Storage not initialized");

    const results: Map<string, SearchResult> = new Map();

    // 1. Vector search (if embedding provided and vec table exists)
    if (embedding) {
      try {
        const vecResults = this.db
          .prepare(
            `SELECT rowid, distance FROM memories_vec
             WHERE embedding MATCH ?
             ORDER BY distance
             LIMIT ?`
          )
          .all(Buffer.from(embedding.buffer), limit * 2) as any[];

        for (const vr of vecResults) {
          const memoryId = this.rowidToId(Number(vr.rowid));
          const record = this.getById(memoryId);
          if (record) {
            const score = 1 - Math.min(vr.distance, 1); // Normalize to 0-1
            const snippet = this.extractSnippet(record.content, query);
            results.set(record.id, { record, score, snippet });
          }
        }
      } catch (err) {
        // Vector search failed, continue with fuzzy
      }
    }

    // 2. Fuzzy text search (split query into words)
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    
    // Build conditions: each word must match either title OR content
    const wordConditions = queryWords.map(() => 
      "(LOWER(title) LIKE LOWER(?) OR LOWER(content) LIKE LOWER(?))"
    ).join(" AND ");
    
    const fuzzyResults = this.db
      .prepare(
        `SELECT id, title, content,
                (CASE WHEN LOWER(title) LIKE LOWER(?) THEN 1 ELSE 0 END) as title_match,
                (CASE WHEN LOWER(content) LIKE LOWER(?) THEN 1 ELSE 0 END) as content_match
         FROM memories
         WHERE ${wordConditions}
         LIMIT ?`
      )
      .all(
        `%${query}%`,
        `%${query}%`,
        ...queryWords.flatMap(w => [`%${w}%`, `%${w}%`]),
        limit * 2
      ) as any[];

    for (const fr of fuzzyResults) {
      const existing = results.get(fr.id);
      const fuzzyScore = (fr.title_match * 0.7 + fr.content_match * 0.3);
      const record = this.getById(fr.id);
      if (record) {
        const snippet = this.extractSnippet(record.content, query);
        if (existing) {
          // Boost score if found in both vector and fuzzy
          existing.score = Math.min(existing.score + fuzzyScore * 0.3, 1);
        } else {
          results.set(fr.id, { record, score: fuzzyScore, snippet });
        }
      }
    }

    // 3. Sort by score and return top results
    return Array.from(results.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Get the underlying database for advanced queries.
   */
  getDb(): Database.Database | null {
    return this.db;
  }

  /**
   * Get the scope directory.
   */
  getScopeDir(): string {
    return this.scopeDir;
  }

  /**
   * Extract a snippet around the query match.
   */
  private extractSnippet(content: string, query: string, chars = 100): string {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerContent.indexOf(lowerQuery);

    if (idx === -1) {
      // No match, return beginning
      return content.slice(0, chars) + (content.length > chars ? "..." : "");
    }

    const start = Math.max(0, idx - chars / 2);
    const end = Math.min(content.length, idx + query.length + chars / 2);
    let snippet = content.slice(start, end);

    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";

    return snippet;
  }

  /**
   * Convert string ID to numeric rowid for sqlite-vec.
   */
  private idToRowid(id: string): number {
    // Simple hash: sum of char codes modulo 1M
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 1_000_000;
  }

  /**
   * Convert numeric rowid back to string ID.
   */
  private rowidToId(rowid: number): string {
    // Look up ID from memories table by rowid
    if (!this.db) return "";
    const row = this.db.prepare("SELECT id FROM memories LIMIT 1 OFFSET ?").get(rowid) as any;
    return row?.id || "";
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
  const projectDirs = getAllProjectDirs();
  const allResults: SearchResult[] = [];

  for (const { name: projectName, dir } of projectDirs) {
    const dbPath = path.join(dir, MEMORY_DB_NAME);
    if (!fs.existsSync(dbPath)) continue;

    try {
      const storage = new MemoryStorage(projectName);
      storage.init();
      const results = storage.search(query, limit);
      allResults.push(...results);
      storage.close();
    } catch {
      // Skip projects with corrupted DB
    }
  }

  // Sort by score and return top results
  return allResults
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * List memories from ALL projects.
 * Returns memories with project name prefix.
 */
export function listAllProjects(): Array<{
  project: string;
  id: string;
  title: string;
  type: string;
}> {
  const projectDirs = getAllProjectDirs();
  const allMemories: Array<{
    project: string;
    id: string;
    title: string;
    type: string;
  }> = [];

  for (const { name: projectName, dir } of projectDirs) {
    const dbPath = path.join(dir, MEMORY_DB_NAME);
    if (!fs.existsSync(dbPath)) continue;

    try {
      const storage = new MemoryStorage(projectName);
      storage.init();
      const memories = storage.listAll();
      allMemories.push(
        ...memories.map((m) => ({
          project: projectName,
          id: m.id,
          title: m.title,
          type: m.type,
        }))
      );
      storage.close();
    } catch {
      // Skip projects with corrupted DB
    }
  }

  return allMemories;
}

/**
 * In-memory storage fallback when SQLite is unavailable.
 */
export class InMemoryStorage {
  private records: Map<string, MemoryRecord> = new Map();
  private projectName: string;
  private globalScope: boolean;

  constructor(projectName: string, globalScope = false) {
    this.projectName = projectName;
    this.globalScope = globalScope;
  }

  store(record: MemoryRecord): void {
    if (!record.id) {
      record.id = record.title.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    }
    const now = new Date().toISOString();
    if (!record.created) record.created = now;
    record.updated = now;
    if (!record.project) record.project = this.projectName;
    this.records.set(record.id, record);
  }

  getById(id: string): MemoryRecord | null {
    return this.records.get(id) || null;
  }

  getByTitle(title: string): MemoryRecord | null {
    for (const record of this.records.values()) {
      if (record.title.toLowerCase() === title.toLowerCase()) {
        return record;
      }
    }
    return null;
  }

  listAll(): Array<{ id: string; title: string; type: string }> {
    return Array.from(this.records.values()).map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
    }));
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }

  deleteByTitle(title: string): boolean {
    const record = this.getByTitle(title);
    if (!record) return false;
    return this.delete(record.id);
  }

  search(query: string, limit = 10): SearchResult[] {
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const record of this.records.values()) {
      const titleMatch = record.title.toLowerCase().includes(lowerQuery);
      const contentMatch = record.content.toLowerCase().includes(lowerQuery);

      if (titleMatch || contentMatch) {
        const score = titleMatch ? 0.7 : 0.3;
        const snippet = this.extractSnippet(record.content, query);
        results.push({ record, score, snippet });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  close(): void {
    // No-op for in-memory
  }

  private extractSnippet(content: string, query: string, chars = 100): string {
    const lowerContent = content.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const idx = lowerContent.indexOf(lowerQuery);

    if (idx === -1) {
      return content.slice(0, chars) + (content.length > chars ? "..." : "");
    }

    const start = Math.max(0, idx - chars / 2);
    const end = Math.min(content.length, idx + query.length + chars / 2);
    let snippet = content.slice(start, end);

    if (start > 0) snippet = "..." + snippet;
    if (end < content.length) snippet = snippet + "...";

    return snippet;
  }
}
