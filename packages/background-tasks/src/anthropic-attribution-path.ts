/**
 * @pi-unipi/background-tasks — Anthropic attribution extension path
 *
 * Resolves this package's own attribution extension entry so isolated child Pi
 * processes can load it explicitly. Mirrors the reference layout:
 * extensions/anthropic-attribution.ts re-exports src/anthropic-attribution.ts.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function resolveAnthropicAttributionExtensionPath(): string {
  // src/anthropic-attribution-path.ts -> packages/background-tasks/extensions/
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "..", "extensions", "anthropic-attribution.ts");
  if (!existsSync(candidate)) {
    throw new Error(`Anthropic attribution extension is missing: ${candidate}`);
  }
  return candidate;
}
