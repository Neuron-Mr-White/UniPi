/**
 * @pi-unipi/updater — NPM registry checker
 *
 * Fetches latest version from npm registry, compares with installed version,
 * respects check interval from config/cache.
 */

import { getInstalledPackageVersion } from "@pi-unipi/core";
import { loadConfig } from "./settings.js";
import { readLastCheck, writeLastCheck, isCheckDue } from "./cache.js";
import { compareVersions, isNewerVersion } from "./version.js";
import type { UpdateCheckResult } from "../types.js";

/** NPM registry URL for the unipi umbrella package */
const NPM_REGISTRY_URL = "https://registry.npmjs.org/@pi-unipi/unipi";

/** Resolve the installed version of @pi-unipi/unipi */
function getInstalledVersion(): string {
  // Walk up from this file to find the @pi-unipi/unipi package by name
  const dir = new URL("..", import.meta.url).pathname;
  return getInstalledPackageVersion(dir, "@pi-unipi/unipi");
}


/** Build an update result without ever reporting downgrades as updates. */
function toUpdateResult(latestVersion: string, currentVersion: string): UpdateCheckResult {
  return {
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    latestVersion,
    currentVersion,
  };
}

/**
 * Check for updates from npm registry.
 * Respects check interval — skips if last check was recent.
 * Returns update status and version info.
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = getInstalledVersion();

  try {
    const config = loadConfig();

    // Check if we need to fetch (interval not elapsed). If the cached npm
    // version is older than the installed version, ignore the interval and
    // refresh: this happens immediately after a local/source release before
    // the updater cache has seen the new npm dist-tag.
    const cache = readLastCheck();
    if (cache && !isCheckDue(config.checkIntervalMs)) {
      if (compareVersions(cache.latestVersion, currentVersion) >= 0) {
        return toUpdateResult(cache.latestVersion, currentVersion);
      }
    }

    // Fetch from npm registry
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { "dist-tags": { latest: string } };
    const latestVersion = data["dist-tags"]?.latest;

    if (!latestVersion) {
      throw new Error("No dist-tags.latest in npm response");
    }

    // Write cache
    writeLastCheck({
      lastCheck: new Date().toISOString(),
      latestVersion,
    });

    return toUpdateResult(latestVersion, currentVersion);
  } catch (err: unknown) {
    // Network error — return cached info if available, but never suggest a
    // downgrade from a stale cache.
    const cache = readLastCheck();
    return {
      updateAvailable: cache ? isNewerVersion(cache.latestVersion, currentVersion) : false,
      latestVersion: cache?.latestVersion ?? "",
      currentVersion,
      error: err instanceof Error ? err.message : String(err) || "Unknown error",
    };
  }
}
