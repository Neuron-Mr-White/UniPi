import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UPDATER_DIRS } from "@pi-unipi/core";
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
    // The `main` fallback (tag not pushed yet) is not: never cache it.
    const cacheable = response.ok;
    if (response.status === 404) {
      response = await fetchImpl(`${CHANGELOG_RAW_BASE}/main/CHANGELOG.md`, { signal });
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
  const newer = remote === null ? [] : getNewerVersions(entries, currentVersion);
  if (newer.length > 0) return newer;
  return getNewerVersions(parseChangelog(resolveChangelogPath()), currentVersion);
}
