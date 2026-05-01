/**
 * @pi-unipi/updater — NPM registry checker
 *
 * Fetches latest version from npm registry, compares with installed version,
 * respects check interval from config/cache.
 */

import { getInstalledPackageVersion } from "@pi-unipi/core";
import { loadConfig } from "./settings.js";
import { readLastCheck, writeLastCheck, isCheckDue } from "./cache.js";
import type { UpdateCheckResult } from "../types.js";

/** NPM registry URL for the unipi umbrella package */
const NPM_REGISTRY_URL = "https://registry.npmjs.org/@pi-unipi/unipi";

/** Resolve the installed version of @pi-unipi/unipi */
function getInstalledVersion(): string {
  // Walk up from this file to find the @pi-unipi/unipi package by name
  const dir = new URL("..", import.meta.url).pathname;
  return getInstalledPackageVersion(dir, "@pi-unipi/unipi");
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

    // Check if we need to fetch (interval not elapsed)
    if (!isCheckDue(config.checkIntervalMs)) {
      const cache = readLastCheck();
      if (cache) {
        return {
          updateAvailable: cache.latestVersion !== currentVersion,
          latestVersion: cache.latestVersion,
          currentVersion,
        };
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

    return {
      updateAvailable: latestVersion !== currentVersion,
      latestVersion,
      currentVersion,
    };
  } catch (err: any) {
    // Network error — return cached info if available
    const cache = readLastCheck();
    return {
      updateAvailable: false,
      latestVersion: cache?.latestVersion ?? "",
      currentVersion,
      error: err.message ?? "Unknown error",
    };
  }
}
