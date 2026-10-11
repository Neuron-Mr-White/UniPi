import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UPDATER_DIRS, compareVersions } from "@pi-unipi/core";
import type { ChangelogEntry } from "../types.js";
import { getNewerVersions, parseChangelogContent, parseChangelog, resolveChangelogPath } from "./changelog.js";

export const CHANGELOG_RAW_BASE = "https://raw.githubusercontent.com/Neuron-Mr-White/unipi";

export interface RemoteChangelogOptions {
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  timeoutMs?: number;
}

function cacheDirectory(opts?: RemoteChangelogOptions): string {
  return (opts?.cacheDir ?? UPDATER_DIRS.CACHE).replace("~", homedir());
}

/**
 * Branches to try when the release tag is missing. Prereleases are pushed to
 * a channel branch (`3.0.0-alpha.36` → `v3.0.0-alpha`); `main` holds the
 * stable line only, so it would show the wrong changelog to an alpha install.
 */
export function fallbackRefs(version: string): string[] {
  const m = /^v?(\d+\.\d+\.\d+-[0-9A-Za-z-]+)\.[0-9A-Za-z.-]+$/.exec(version);
  return m ? [`v${m[1]}`, "main"] : ["main"];
}

export async function fetchRemoteChangelog(version: string, opts: RemoteChangelogOptions = {}): Promise<string | null> {
  const cacheDir = cacheDirectory(opts);
  const cachePath = join(cacheDir, `changelog-${version}.md`);
  try {
    if (existsSync(cachePath)) return readFileSync(cachePath, "utf8");
  } catch {
    // Continue with the network request.
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 5000);
  try {
    let response = await fetchImpl(`${CHANGELOG_RAW_BASE}/v${version}/CHANGELOG.md`, { signal });
    // The release tag is immutable, so its changelog is safe to cache forever.
    // The branch fallbacks (tag not pushed yet) are not: never cache them.
    const cacheable = response.ok;
    for (const ref of fallbackRefs(version)) {
      if (response.status !== 404) break;
      response = await fetchImpl(`${CHANGELOG_RAW_BASE}/${ref}/CHANGELOG.md`, { signal });
    }
    if (!response.ok) return null;
    const content = await response.text();
    if (cacheable) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachePath, content, "utf8");
    }
    return content;
  } catch {
    return null;
  }
}

export async function loadUpdateChangelog(
  currentVersion: string,
  latestVersion: string,
  opts?: RemoteChangelogOptions,
): Promise<ChangelogEntry[]> {
  const remote = await fetchRemoteChangelog(latestVersion, opts);
  const entries = remote === null ? [] : parseChangelogContent(remote);
  const upTo = (list: ChangelogEntry[]) =>
    list.filter((e) => e.version === "Unreleased" || compareVersions(e.version, latestVersion) <= 0);
  const newer = remote === null ? [] : upTo(getNewerVersions(entries, currentVersion));
  if (newer.length > 0) return newer;
  return upTo(getNewerVersions(parseChangelog(resolveChangelogPath()), currentVersion));
}
