/**
 * SQLite backend abstraction with auto-detection
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultDBPath(name: string): string {
  const path = join(homedir(), ".unipi", "db", "compactor", `${name}.db`);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path;
}

let sqliteLib: any = null;
let sqliteFlavor: "bun" | "better-sqlite3" | null = null;

export async function loadSQLite() {
  if (sqliteLib) return { lib: sqliteLib, flavor: sqliteFlavor! };

  // Try bun:sqlite first (Bun runtime)
  try {
    sqliteLib = await import("bun:sqlite" as any);
    sqliteFlavor = "bun";
    return { lib: sqliteLib, flavor: sqliteFlavor };
  } catch {
    // Skip node:sqlite — its API (DatabaseSync) is incompatible with
    // better-sqlite3's constructor pattern (Database class).
    try {
      sqliteLib = await import("better-sqlite3");
      sqliteFlavor = "better-sqlite3";
      return { lib: sqliteLib, flavor: sqliteFlavor };
    } catch {
      sqliteLib = {};
      sqliteFlavor = "better-sqlite3";
      return { lib: sqliteLib, flavor: sqliteFlavor };
    }
  }
}

export function applyWALPragmas(db: any): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

export function withRetry<T>(fn: () => T, maxRetries = 3): T {
  let lastErr: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return fn();
    } catch (err: any) {
      lastErr = err;
      if (err?.code === "SQLITE_BUSY" && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 10 + Math.random() * 10;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function isSQLiteCorruptionError(err: any): boolean {
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("database disk image is malformed") ||
    msg.includes("database is locked") ||
    msg.includes("file is not a database");
}

export interface PreparedStatement {
  get(...args: any[]): any;
  all(...args: any[]): any[];
  run(...args: any[]): { changes: number };
}
