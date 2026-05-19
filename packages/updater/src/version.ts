/**
 * @pi-unipi/updater — version comparison helpers
 */

/**
 * Compare two semver-ish version strings.
 * Returns 1 when a > b, -1 when a < b, 0 when equal.
 *
 * This intentionally handles the simple versions Unipi publishes (x.y.z)
 * without adding a runtime dependency. Non-numeric suffixes are ignored for
 * ordering, so `2.0.5` and `v2.0.5` compare equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): number[] => version
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });

  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff > 0) return 1;
    if (diff < 0) return -1;
  }
  return 0;
}

/** Return true only when `latest` is newer than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
