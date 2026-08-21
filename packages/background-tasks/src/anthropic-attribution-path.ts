/**
 * @pi-unipi/background-tasks — Anthropic attribution extension path
 *
 * Resolves this package's own attribution extension entry so isolated child Pi
 * processes can load it explicitly. Full subsystem lands in Phase 6.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function resolveAnthropicAttributionExtensionPath(): string {
  return join(here, "..", "src", "anthropic-attribution.ts");
}
