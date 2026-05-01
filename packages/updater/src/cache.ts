/**
 * @pi-unipi/updater — Last-check cache
 *
 * Reads/writes last-check.json to ~/.unipi/cache/updater/last-check.json
 * Tracks when the last npm check was performed and what version was found.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { UPDATER_DIRS } from "@pi-unipi/core";
import type { LastCheckCache } from "../types.js";

/** Resolve cache path */
function resolveCachePath(): string {
  const base = UPDATER_DIRS.CACHE.replace("~", homedir());
  return join(base, "last-check.json");
}

/** Read cache from disk, returning null if missing or invalid */
export function readLastCheck(): LastCheckCache | null {
  const cachePath = resolveCachePath();
  try {
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(raw) as LastCheckCache;
      if (parsed.lastCheck && parsed.latestVersion) {
        return parsed;
      }
    }
  } catch (_err) {
    // Cache read failure — treat as missing.
  }
  return null;
}

/** Write cache to disk, creating directory if needed */
export function writeLastCheck(cache: LastCheckCache): void {
  const cachePath = resolveCachePath();
  const dir = dirname(cachePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

/** Check if enough time has elapsed since last check */
export function isCheckDue(intervalMs: number): boolean {
  const cache = readLastCheck();
  if (!cache) return true;

  const lastCheckTime = new Date(cache.lastCheck).getTime();
  const now = Date.now();
  return now - lastCheckTime >= intervalMs;
}

/** Write skipped version to cache */
export function writeSkippedVersion(version: string): void {
  const cache = readLastCheck();
  if (cache) {
    writeLastCheck({ ...cache, skippedVersion: version });
  }
}

/** Check if a version was skipped by the user */
export function isVersionSkipped(version: string): boolean {
  const cache = readLastCheck();
  return cache?.skippedVersion === version;
}
