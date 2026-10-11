/**
 * @pi-unipi/updater — NPM registry checker
 *
 * Fetches the dist-tag of the install's release channel (UNI-262: an alpha
 * install follows `alpha`, never `latest`), compares with the installed
 * version, never offers a lower version, and respects the check interval.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getInstalledPackageVersion } from "@pi-unipi/core";
import { loadConfig } from "./settings.js";
import { readLastCheck, writeLastCheck, isCheckDue } from "./cache.js";
import { compareVersions, isNewerVersion } from "./version.js";
import { pickChannelVersion, readUnipiPackageSpec, resolveChannel, UNIPI_PACKAGE } from "./channel.js";
import type { UpdateCheckResult } from "../types.js";

/** npm registry base; `UNIPI_UPDATER_REGISTRY` overrides it (tests / mirrors). */
export function registryUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.UNIPI_UPDATER_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
  return `${base}/-/package/${UNIPI_PACKAGE}/dist-tags`;
}

/** Resolve the installed version of @pi-unipi/unipi */
export function getInstalledVersion(): string {
  // fileURLToPath, not URL.pathname: on Windows the latter is "/C:/…".
  const dir = dirname(dirname(fileURLToPath(import.meta.url)));
  return getInstalledPackageVersion(dir, UNIPI_PACKAGE);
}

/** The channel this install follows. */
export function currentChannel(currentVersion = getInstalledVersion()): string {
  return resolveChannel(currentVersion, readUnipiPackageSpec());
}

/** Build an update result without ever reporting downgrades as updates. */
function toUpdateResult(latestVersion: string, currentVersion: string, channel: string): UpdateCheckResult {
  return {
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    latestVersion,
    currentVersion,
    channel,
  };
}

export interface CheckOptions {
  fetchImpl?: typeof fetch;
  currentVersion?: string;
  channel?: string;
  /** Ignore the interval cache. */
  force?: boolean;
}

/**
 * Check for updates on this install's channel.
 * Respects check interval — skips if last check was recent.
 */
export async function checkForUpdates(opts: CheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = opts.currentVersion ?? getInstalledVersion();
  const channel = opts.channel ?? currentChannel(currentVersion);

  try {
    const config = loadConfig();

    // A cache is only reused for the same channel (an old cache written by
    // the pre-UNI-262 checker holds `latest`). If the cached version is older
    // than the installed one, refresh: right after a release the cache has
    // not seen the new dist-tag yet.
    const cache = readLastCheck();
    if (!opts.force && cache && (cache.channel ?? "latest") === channel && !isCheckDue(config.checkIntervalMs)) {
      if (compareVersions(cache.latestVersion, currentVersion) >= 0) {
        return toUpdateResult(cache.latestVersion, currentVersion, channel);
      }
    }

    const fetchImpl = opts.fetchImpl ?? fetch;
    const response = await fetchImpl(registryUrl(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const body = await response.json() as Record<string, unknown>;
    // The dist-tags endpoint returns the map itself; the full packument nests it.
    const tags = (body["dist-tags"] ?? body) as Record<string, string>;
    const latestVersion = pickChannelVersion(tags, channel);

    if (!latestVersion) {
      throw new Error(`No dist-tag "${channel}" in npm response`);
    }

    writeLastCheck({
      lastCheck: new Date().toISOString(),
      latestVersion,
      channel,
      skippedVersion: cache?.skippedVersion,
    });

    return toUpdateResult(latestVersion, currentVersion, channel);
  } catch (err: unknown) {
    // Network error — reuse cached info for this channel only, and never
    // suggest a downgrade from a stale cache.
    const cache = readLastCheck();
    const usable = cache && (cache.channel ?? "latest") === channel ? cache : null;
    return {
      updateAvailable: usable ? isNewerVersion(usable.latestVersion, currentVersion) : false,
      latestVersion: usable?.latestVersion ?? "",
      currentVersion,
      channel,
      error: err instanceof Error ? err.message : String(err) || "Unknown error",
    };
  }
}
