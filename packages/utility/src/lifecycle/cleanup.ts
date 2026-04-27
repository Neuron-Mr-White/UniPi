/**
 * @pi-unipi/utility — Stale Cleanup Utility
 *
 * Cleans stale DBs, temp files, old sessions across all unipi modules.
 */

import { existsSync, statSync, readdirSync, unlinkSync, rmdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { CleanupReport, CleanupResult, CleanupOptions } from "../types.js";

/** Default options */
const DEFAULTS: Required<CleanupOptions> = {
  dbMaxAgeDays: 14,
  tempMaxAgeDays: 7,
  sessionMaxAgeDays: 30,
  dryRun: false,
};

/** Expand ~ to home directory */
function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Check if a file is older than maxAgeDays */
function isStale(path: string, maxAgeDays: number): boolean {
  try {
    const stats = statSync(path);
    const ageMs = Date.now() - stats.mtime.getTime();
    return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/** Try to detect if a DB file has a zombie WAL lock */
function hasWalLock(dbPath: string): boolean {
  const walPath = dbPath + "-wal";
  const shmPath = dbPath + "-shm";
  // If WAL exists but journal mode isn't WAL, or WAL is very old, it's stale
  if (existsSync(walPath)) {
    try {
      const walStats = statSync(walPath);
      const ageMs = Date.now() - walStats.mtime.getTime();
      return ageMs > 5 * 60 * 1000; // 5 min = stale WAL
    } catch {
      return false;
    }
  }
  return false;
}

/** Clean stale database files in ~/.unipi/ */
function cleanDbs(options: Required<CleanupOptions>): CleanupResult {
  const result: CleanupResult = {
    category: "db",
    removed: 0,
    bytesFreed: 0,
    paths: [],
  };

  const unipiDir = expandHome("~/.unipi");
  if (!existsSync(unipiDir)) return result;

  const scanDir = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          scanDir(fullPath);
          continue;
        }

        // Match SQLite DB files
        if (
          entry.endsWith(".db") ||
          entry.endsWith(".sqlite") ||
          entry.endsWith(".sqlite3")
        ) {
          if (isStale(fullPath, options.dbMaxAgeDays) || hasWalLock(fullPath)) {
            result.bytesFreed += stats.size;
            result.paths.push(fullPath);
            if (!options.dryRun) {
              try {
                unlinkSync(fullPath);
                // Also clean WAL/SHM companions
                for (const suffix of ["-wal", "-shm", "-journal"]) {
                  const companion = fullPath + suffix;
                  if (existsSync(companion)) {
                    unlinkSync(companion);
                    result.bytesFreed += statSync(companion).size;
                  }
                }
                result.removed++;
              } catch {
                // Best effort
              }
            } else {
              result.removed++;
            }
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  };

  scanDir(unipiDir);
  return result;
}

/** Clean temp files matching unipi patterns */
function cleanTemps(options: Required<CleanupOptions>): CleanupResult {
  const result: CleanupResult = {
    category: "temp",
    removed: 0,
    bytesFreed: 0,
    paths: [],
  };

  const patterns = [/^unipi-/, /^pi-/, /\.unipi\./];
  const tmpDir = tmpdir();

  let entries: string[];
  try {
    entries = readdirSync(tmpDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!patterns.some((p) => p.test(entry))) continue;

    const fullPath = join(tmpDir, entry);
    try {
      const stats = statSync(fullPath);
      if (!stats.isFile()) continue;

      if (isStale(fullPath, options.tempMaxAgeDays)) {
        result.bytesFreed += stats.size;
        result.paths.push(fullPath);
        if (!options.dryRun) {
          try {
            unlinkSync(fullPath);
            result.removed++;
          } catch {
            // Best effort
          }
        } else {
          result.removed++;
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  return result;
}

/** Clean stale session directories */
function cleanSessions(options: Required<CleanupOptions>): CleanupResult {
  const result: CleanupResult = {
    category: "session",
    removed: 0,
    bytesFreed: 0,
    paths: [],
  };

  const unipiDir = expandHome("~/.unipi");
  const sessionsDir = join(unipiDir, "sessions");
  if (!existsSync(sessionsDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(sessionsDir, entry);
    try {
      const stats = statSync(fullPath);
      if (!stats.isDirectory()) continue;

      if (isStale(fullPath, options.sessionMaxAgeDays)) {
        result.bytesFreed += stats.size;
        result.paths.push(fullPath);
        if (!options.dryRun) {
          try {
            // Remove directory contents then directory
            const removeRecursive = (dir: string) => {
              const items = readdirSync(dir);
              for (const item of items) {
                const itemPath = join(dir, item);
                const itemStats = statSync(itemPath);
                if (itemStats.isDirectory()) {
                  removeRecursive(itemPath);
                } else {
                  unlinkSync(itemPath);
                }
              }
              rmdirSync(dir);
            };
            removeRecursive(fullPath);
            result.removed++;
          } catch {
            // Best effort
          }
        } else {
          result.removed++;
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  return result;
}

/** Clean stale cache files */
function cleanCache(options: Required<CleanupOptions>): CleanupResult {
  const result: CleanupResult = {
    category: "cache",
    removed: 0,
    bytesFreed: 0,
    paths: [],
  };

  const cacheDir = expandHome("~/.unipi/cache");
  if (!existsSync(cacheDir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(cacheDir, entry);
    try {
      const stats = statSync(fullPath);
      if (!stats.isFile()) continue;

      if (isStale(fullPath, options.tempMaxAgeDays)) {
        result.bytesFreed += stats.size;
        result.paths.push(fullPath);
        if (!options.dryRun) {
          try {
            unlinkSync(fullPath);
            result.removed++;
          } catch {
            // Best effort
          }
        } else {
          result.removed++;
        }
      }
    } catch {
      // Skip unreadable
    }
  }

  return result;
}

/**
 * Run full cleanup of stale files across all unipi modules.
 */
export function cleanupStale(options: CleanupOptions = {}): CleanupReport {
  const opts: Required<CleanupOptions> = { ...DEFAULTS, ...options };

  const results: CleanupResult[] = [
    cleanDbs(opts),
    cleanTemps(opts),
    cleanSessions(opts),
    cleanCache(opts),
  ];

  return {
    timestamp: Date.now(),
    results,
    totalRemoved: results.reduce((sum, r) => sum + r.removed, 0),
    totalBytesFreed: results.reduce((sum, r) => sum + r.bytesFreed, 0),
  };
}

/** Format a cleanup report as markdown */
export function formatCleanupReport(report: CleanupReport): string {
  const lines = [
    "## 🧹 Cleanup Report",
    "",
    `**Total removed:** ${report.totalRemoved} items`,
    `**Space freed:** ${(report.totalBytesFreed / 1024 / 1024).toFixed(2)} MB`,
    `**Timestamp:** ${new Date(report.timestamp).toISOString()}`,
    "",
  ];

  for (const result of report.results) {
    if (result.removed === 0) continue;
    lines.push(
      `### ${result.category.toUpperCase()}`,
      `- Removed: ${result.removed}`,
      `- Freed: ${(result.bytesFreed / 1024).toFixed(1)} KB`,
      "",
    );
    for (const path of result.paths.slice(0, 10)) {
      lines.push(`- \`${path}\``);
    }
    if (result.paths.length > 10) {
      lines.push(`- ... and ${result.paths.length - 10} more`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
