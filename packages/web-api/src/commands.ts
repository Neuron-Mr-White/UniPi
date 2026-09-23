/**
 * @unipi/web-api — Commands registration
 *
 * Registers /unipi:web-cache-clear. Provider/fetch settings live in the
 * unified /unipi:settings hub (web-api namespace).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";
import { webCache } from "./cache.js";

/** Command names */
export const WEB_COMMANDS = {
  CACHE_CLEAR: "web-cache-clear",
} as const;

/**
 * Register web commands with pi.
 */
export function registerWebCommands(pi: ExtensionAPI): void {
  // --- /unipi:web-cache-clear command ---
  pi.registerCommand(`${UNIPI_PREFIX}${WEB_COMMANDS.CACHE_CLEAR}`, {
    description: "Clear all cached web content",
    handler: async (_args, ctx) => {
      const stats = webCache.getStats();
      const cleared = webCache.clear();

      ctx.ui.notify(
        `Cache cleared: ${cleared} entries removed (${stats.totalSizeBytes} bytes freed)`,
        "info",
      );
    },
  });
}
