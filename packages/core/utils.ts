/**
 * @unipi/core — Shared utility functions
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Sanitize a string for use as a filename.
 * Replaces non-alphanumeric chars with underscores, collapses repeats.
 */
export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
}

/**
 * Ensure parent directory exists for a file path.
 */
export function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Try to delete a file. Ignores errors.
 */
export function tryDelete(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * Try to read a file. Returns null on error.
 */
export function tryRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get file mtime in ms. Returns 0 if file doesn't exist.
 */
export function safeMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Try to remove a directory recursively. Returns true on success.
 */
export function tryRemoveDir(dirPath: string): boolean {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a path relative to cwd, handling absolute paths.
 */
export function resolvePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

/**
 * Check if a file exists.
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Write a file, ensuring parent directory exists.
 */
export function writeFile(filePath: string, content: string): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, content, "utf-8");
}

/**
 * Read JSON file, return null on error.
 */
export function readJson<T>(filePath: string): T | null {
  const content = tryRead(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Write JSON file with pretty printing.
 */
export function writeJson(filePath: string, data: unknown): void {
  writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Generate a short random ID.
 */
export function randomId(length = 8): string {
  return Math.random().toString(36).substring(2, 2 + length);
}

/**
 * Format timestamp to ISO string.
 */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Parse command arguments string into tokens.
 * Handles quoted strings.
 */
export function parseArgs(argsStr: string): string[] {
  return argsStr.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
}

/**
 * Get package version from package.json.
 */
export function getPackageVersion(packageDir: string): string {
  const pkgPath = path.join(packageDir, "package.json");
  const pkg = readJson<{ version?: string }>(pkgPath);
  return pkg?.version ?? "0.0.0";
}

/**
 * Check if a module is available in node_modules.
 */
export function isModuleAvailable(cwd: string, moduleName: string): boolean {
  try {
    const resolved = path.join(cwd, "node_modules", moduleName);
    return fs.existsSync(resolved);
  } catch {
    return false;
  }
}

/**
 * Initialize .unipi directory structure.
 * Creates all standard directories if they don't exist.
 * Call on session_start in each extension.
 */
export function initUnipiDirs(cwd: string = process.cwd()): void {
  const dirs = [
    ".unipi",
    ".unipi/docs",
    ".unipi/docs/specs",
    ".unipi/docs/plans",
    ".unipi/docs/generated",
    ".unipi/docs/reviews",
    ".unipi/memory",
    ".unipi/quick-work",
    ".unipi/worktrees",
  ];
  for (const dir of dirs) {
    const full = path.join(cwd, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  }
}

/**
 * Emit a unipi event via pi.events (safe wrapper).
 * Returns true if event was emitted.
 */
export function emitEvent(
  pi: { events: { emit: (name: string, payload: unknown) => void } },
  eventName: string,
  payload: unknown,
): boolean {
  try {
    pi.events.emit(eventName, payload);
    return true;
  } catch {
    return false;
  }
}
