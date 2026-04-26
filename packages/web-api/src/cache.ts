/**
 * @unipi/web-api — Cache layer
 *
 * Caches web content with configurable TTL.
 * Manual invalidation via /unipi:web-cache-clear command.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

/** Cache entry structure */
export interface CacheEntry {
  /** Cache key */
  key: string;
  /** Cached data */
  data: unknown;
  /** Timestamp when cached */
  timestamp: number;
  /** TTL in milliseconds */
  ttlMs: number;
  /** Provider that produced this data */
  provider: string;
  /** URL that was cached */
  url: string;
}

/** Cache statistics */
export interface CacheStats {
  /** Total number of entries */
  totalEntries: number;
  /** Total size in bytes */
  totalSizeBytes: number;
  /** Expired entries count */
  expiredEntries: number;
}

/**
 * WebCache manages cached web content.
 */
export class WebCache {
  private cacheDir: string;
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 3600000) {
    this.cacheDir = path.join(os.homedir(), ".unipi", "config", "web-api", "cache");
    this.defaultTtlMs = defaultTtlMs;
    this.ensureCacheDir();
  }

  /**
   * Ensure cache directory exists.
   */
  private ensureCacheDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Generate cache key from URL and provider.
   */
  private generateKey(url: string, provider: string): string {
    const content = `${provider}:${url}`;
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Get file path for a cache key.
   */
  private getFilePath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  /**
   * Get cached data.
   * @param url - URL to get from cache
   * @param provider - Provider that produced the data
   * @returns Cached data or null if not found/expired
   */
  get(url: string, provider: string): unknown | null {
    const key = this.generateKey(url, provider);
    const filePath = this.getFilePath(key);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const entry: CacheEntry = JSON.parse(content);

      // Check if expired
      const now = Date.now();
      if (now - entry.timestamp > entry.ttlMs) {
        // Expired, remove file
        this.deleteEntry(key);
        return null;
      }

      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Set cached data.
   * @param url - URL to cache
   * @param provider - Provider that produced the data
   * @param data - Data to cache
   * @param ttlMs - TTL in milliseconds (optional, uses default)
   */
  set(url: string, provider: string, data: unknown, ttlMs?: number): void {
    const key = this.generateKey(url, provider);
    const filePath = this.getFilePath(key);

    const entry: CacheEntry = {
      key,
      data,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.defaultTtlMs,
      provider,
      url,
    };

    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), "utf-8");
  }

  /**
   * Delete a cache entry by key.
   */
  private deleteEntry(key: string): void {
    const filePath = this.getFilePath(key);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Clear all cached data.
   * @returns Number of entries cleared
   */
  clear(): number {
    let count = 0;
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(this.cacheDir, file);
          fs.unlinkSync(filePath);
          count++;
        }
      }
    } catch {
      // Ignore errors
    }
    return count;
  }

  /**
   * Clear expired entries.
   * @returns Number of expired entries cleared
   */
  clearExpired(): number {
    let count = 0;
    const now = Date.now();

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(this.cacheDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const entry: CacheEntry = JSON.parse(content);

          if (now - entry.timestamp > entry.ttlMs) {
            fs.unlinkSync(filePath);
            count++;
          }
        } catch {
          // If we can't read/parse, delete it
          fs.unlinkSync(filePath);
          count++;
        }
      }
    } catch {
      // Ignore errors
    }

    return count;
  }

  /**
   * Get cache statistics.
   */
  getStats(): CacheStats {
    let totalEntries = 0;
    let totalSizeBytes = 0;
    let expiredEntries = 0;
    const now = Date.now();

    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        const filePath = path.join(this.cacheDir, file);
        try {
          const stat = fs.statSync(filePath);
          totalSizeBytes += stat.size;
          totalEntries++;

          const content = fs.readFileSync(filePath, "utf-8");
          const entry: CacheEntry = JSON.parse(content);

          if (now - entry.timestamp > entry.ttlMs) {
            expiredEntries++;
          }
        } catch {
          totalEntries++;
        }
      }
    } catch {
      // Ignore errors
    }

    return { totalEntries, totalSizeBytes, expiredEntries };
  }
}

/** Singleton cache instance */
export const webCache = new WebCache();
