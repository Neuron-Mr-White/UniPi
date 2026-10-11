/**
 * @pi-unipi/updater — release channel resolution (UNI-262)
 *
 * UniPi 3 ships on the npm `alpha` dist-tag while `latest` still points at the
 * 2.x line. Comparing an alpha install against `latest` offered a downgrade.
 * The channel to follow comes from, in order:
 *   1. the pi settings package spec (`npm:@pi-unipi/unipi@alpha`) when its
 *      version part is a dist-tag (not a pinned semver),
 *   2. the installed version's prerelease id (`3.0.0-alpha.36` → `alpha`),
 *   3. `latest`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "@pi-unipi/core";

export const UNIPI_PACKAGE = "@pi-unipi/unipi";

/** `3.0.0-alpha.36` → `alpha`; stable → null. */
export function prereleaseChannel(version: string): string | null {
  const m = /^v?\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version.trim());
  if (!m) return null;
  const id = m[1]!;
  return /^\d+$/.test(id) ? null : id;
}

/** `npm:@pi-unipi/unipi@alpha` → `alpha`; pinned semver / no tag / other package → null. */
export function channelFromSpec(spec: string): string | null {
  const s = spec.trim().replace(/^npm:/, "");
  if (!s.startsWith(`${UNIPI_PACKAGE}@`)) return null;
  const tag = s.slice(UNIPI_PACKAGE.length + 1).trim();
  if (!tag) return null;
  // A pinned or ranged version is not a channel.
  if (/^[\^~<>=v]?\d/.test(tag) || tag === "*") return null;
  return tag;
}

/** pi's agent dir (honours PI_CODING_AGENT_DIR like pi itself). */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (dir) return dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir;
  return join(homedir(), ".pi", "agent");
}

/** The UniPi package spec from pi settings (project first, then global), if any. */
export function readUnipiPackageSpec(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string | null {
  const files = [join(cwd, ".pi", "settings.json"), join(piAgentDir(env), "settings.json")];
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      const settings = JSON.parse(readFileSync(file, "utf8")) as { packages?: Array<string | { source?: string }> };
      for (const pkg of settings.packages ?? []) {
        const source = typeof pkg === "string" ? pkg : pkg?.source;
        if (typeof source !== "string") continue;
        const bare = source.trim().replace(/^npm:/, "");
        if (bare === UNIPI_PACKAGE || bare.startsWith(`${UNIPI_PACKAGE}@`)) return source.trim();
      }
    } catch {
      // Unreadable settings — try the next file.
    }
  }
  return null;
}

/** The dist-tag this install follows. */
export function resolveChannel(installedVersion: string, spec: string | null): string {
  return (spec ? channelFromSpec(spec) : null) ?? prereleaseChannel(installedVersion) ?? "latest";
}

/**
 * Pick the version to offer from a dist-tags map. A prerelease channel also
 * considers `latest` so a graduation (3.0.0 stable) is still offered; a stable
 * install never sees prerelease tags. Returns null if nothing usable.
 */
export function pickChannelVersion(distTags: Record<string, string> | undefined, channel: string): string | null {
  if (!distTags) return null;
  const candidates = [distTags[channel], channel !== "latest" ? distTags.latest : undefined]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}

/** The `pi install` source for this channel. */
export function installSpec(channel: string): string {
  return channel === "latest" ? `npm:${UNIPI_PACKAGE}` : `npm:${UNIPI_PACKAGE}@${channel}`;
}
