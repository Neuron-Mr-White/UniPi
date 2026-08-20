/**
 * @pi-unipi/core — Model Cache
 *
 * File-based model list cache at ~/.unipi/config/models-cache.json.
 * Allows TUI components and other packages to list available models
 * without needing ctx.modelRegistry at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Resolve the model cache directory at call time (respects HOME changes). */
function cacheDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? "~",
    ".unipi/config",
  );
}

/** Resolve the model cache file path at call time. */
function cacheFile(): string {
  return path.join(cacheDir(), "models-cache.json");
}

/** A single cached model entry */
export interface CachedModel {
  /** Model provider (e.g. "openai", "anthropic") */
  provider: string;
  /** Model ID (e.g. "gpt-4o", "claude-sonnet-4-6") */
  id: string;
  /** Optional display name */
  name?: string;
}

/** The full model cache structure */
export interface ModelCache {
  /** ISO timestamp of last cache write */
  updatedAt: string;
  /** List of cached models */
  models: CachedModel[];
}

/**
 * Read cached model list from disk.
 * Returns empty array if no cache file exists or it's malformed.
 */
export function readModelCache(): CachedModel[] {
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
}

/**
 * Write model list to cache file.
 * Creates directory if needed. Best effort — silently ignores errors.
 */
export function writeModelCache(models: CachedModel[]): void {
  try {
    const dir = cacheDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const cache: ModelCache = {
      updatedAt: new Date().toISOString(),
      models,
    };
    fs.writeFileSync(cacheFile(), JSON.stringify(cache, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort — cache is optional
  }
}
