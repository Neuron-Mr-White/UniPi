/**
 * @pi-unipi/utility — TTL Cache
 *
 * General-purpose TTL cache with memory + SQLite backends.
 */

import type { CacheEntry, CacheBackend, TTLCacheOptions } from "../types.js";

// ─── Memory Backend ──────────────────────────────────────────────────────────

class MemoryBackend<K, V> implements CacheBackend<K, V> {
  private store = new Map<K, CacheEntry<V>>();
  private maxEntries: number;

  constructor(maxEntries: number = 1000) {
    this.maxEntries = maxEntries;
  }

  async get(key: K): Promise<V | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: K, value: V, ttlMs: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) {
        this.store.delete(firstKey);
      }
    }

    const now = Date.now();
    this.store.set(key, {
      value,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
  }

  async has(key: K): Promise<boolean> {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  async delete(key: K): Promise<boolean> {
    return this.store.delete(key);
  }

  async cleanupExpired(): Promise<number> {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

// ─── SQLite Backend ──────────────────────────────────────────────────────────

// Minimal sqlite3 type declarations for lazy loading
interface Sqlite3Db {
  run(sql: string, callback?: (err: Error | null) => void): Sqlite3Db;
  run(sql: string, params: unknown[], callback?: (err: Error | null) => void): Sqlite3Db;
  get(sql: string, params: unknown[], callback: (err: Error | null, row: unknown) => void): Sqlite3Db;
  close(callback?: (err: Error | null) => void): void;
}

interface Sqlite3 {
  Database: new (path: string) => Sqlite3Db;
}

// Lazy-load sqlite to avoid hard dependency
let sqlite3: Sqlite3 | null = null;
let sqliteLoadAttempted = false;

async function loadSqlite(): Promise<Sqlite3 | null> {
  if (sqliteLoadAttempted) return sqlite3;
  sqliteLoadAttempted = true;
  try {
    // Use dynamic import with type assertion to bypass module resolution
    const mod = await eval("import('sqlite3')") as { default?: Sqlite3; Database?: unknown } | Sqlite3;
    if (mod && typeof mod === "object") {
      // Handle both ESM default export and CJS-style export
      sqlite3 = (mod as { default?: Sqlite3 }).default ?? (mod as Sqlite3);
    }
  } catch {
    sqlite3 = null;
  }
  return sqlite3;
}

class SQLiteBackend<K, V> implements CacheBackend<K, V> {
  private db: Sqlite3Db | null = null;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const sqlite = await loadSqlite();
    if (!sqlite) {
      throw new Error("sqlite3 not available for persistent cache");
    }
    this.db = new sqlite.Database(this.dbPath);

    await new Promise<void>((resolve, reject) => {
      this.db!.run(
        `CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`,
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
    });

    // Create index for fast expiration queries
    await new Promise<void>((resolve, reject) => {
      this.db!.run(
        `CREATE INDEX IF NOT EXISTS idx_expires ON cache(expires_at)`,
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
    });
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  async get(key: K): Promise<V | undefined> {
    await this.ensureReady();
    if (!this.db) return undefined;

    const row = await new Promise<{ value: string; expires_at: number } | undefined>(
      (resolve, reject) => {
        this.db!.get(
          "SELECT value, expires_at FROM cache WHERE key = ?",
          [String(key)],
          (err: Error | null, row: unknown) => {
            if (err) reject(err);
            else resolve(row as { value: string; expires_at: number } | undefined);
          },
        );
      },
    );

    if (!row) return undefined;
    if (Date.now() > row.expires_at) {
      await this.delete(key);
      return undefined;
    }

    try {
      return JSON.parse(row.value) as V;
    } catch {
      return undefined;
    }
  }

  async set(key: K, value: V, ttlMs: number): Promise<void> {
    await this.ensureReady();
    if (!this.db) return;

    const now = Date.now();
    const expiresAt = now + ttlMs;
    const serialized = JSON.stringify(value);

    await new Promise<void>((resolve, reject) => {
      this.db!.run(
        `INSERT INTO cache (key, value, expires_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at,
           created_at = excluded.created_at`,
        [String(key), serialized, expiresAt, now],
        (err: Error | null) => (err ? reject(err) : resolve()),
      );
    });
  }

  async has(key: K): Promise<boolean> {
    const value = await this.get(key);
    return value !== undefined;
  }

  async delete(key: K): Promise<boolean> {
    await this.ensureReady();
    if (!this.db) return false;

    return new Promise<boolean>((resolve, reject) => {
      this.db!.run(
        "DELETE FROM cache WHERE key = ?",
        [String(key)],
        function (this: { changes: number }, err: Error | null) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        },
      );
    });
  }

  async cleanupExpired(): Promise<number> {
    await this.ensureReady();
    if (!this.db) return 0;

    return new Promise<number>((resolve, reject) => {
      this.db!.run(
        "DELETE FROM cache WHERE expires_at <= ?",
        [Date.now()],
        function (this: { changes: number }, err: Error | null) {
          if (err) reject(err);
          else resolve(this.changes);
        },
      );
    });
  }

  async clear(): Promise<void> {
    await this.ensureReady();
    if (!this.db) return;

    await new Promise<void>((resolve, reject) => {
      this.db!.run("DELETE FROM cache", (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

// ─── TTL Cache ───────────────────────────────────────────────────────────────

/** Default options */
const DEFAULTS: Required<TTLCacheOptions> = {
  persistent: false,
  dbPath: "",
  defaultTtlMs: 3600000, // 1 hour
  maxMemoryEntries: 1000,
};

/**
 * General-purpose TTL cache with optional SQLite persistence.
 */
export class TTLCache<K = string, V = unknown> {
  private backend: CacheBackend<K, V>;
  private opts: Required<TTLCacheOptions>;

  constructor(options: TTLCacheOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };

    if (this.opts.persistent) {
      const dbPath =
        this.opts.dbPath ||
        new URL("~/.unipi/cache/ttl-cache.db", import.meta.url).pathname;
      this.backend = new SQLiteBackend<K, V>(dbPath);
    } else {
      this.backend = new MemoryBackend<K, V>(this.opts.maxMemoryEntries);
    }
  }

  /** Get a value by key */
  async get(key: K): Promise<V | undefined> {
    return this.backend.get(key);
  }

  /** Set a value with TTL */
  async set(key: K, value: V, ttlMs?: number): Promise<void> {
    return this.backend.set(key, value, ttlMs ?? this.opts.defaultTtlMs);
  }

  /** Check if key exists and is not expired */
  async has(key: K): Promise<boolean> {
    return this.backend.has(key);
  }

  /** Delete a key */
  async delete(key: K): Promise<boolean> {
    return this.backend.delete(key);
  }

  /** Clean up all expired entries */
  async cleanupExpired(): Promise<number> {
    return this.backend.cleanupExpired();
  }

  /** Clear all entries */
  async clear(): Promise<void> {
    return this.backend.clear();
  }
}
