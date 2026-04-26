/**
 * @unipi/web-api — Commands registration
 *
 * Registers /unipi:web-settings and /unipi:web-cache-clear commands.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";
import { showSettingsDialog } from "./tui/settings-dialog.js";
import { webCache } from "./cache.js";

/** Command names */
export const WEB_COMMANDS = {
  SETTINGS: "web-settings",
  CACHE_CLEAR: "web-cache-clear",
} as const;

/**
 * Register web commands with pi.
 */
export function registerWebCommands(pi: ExtensionAPI): void {
  // --- /unipi:web-settings command ---
  pi.registerCommand(`${UNIPI_PREFIX}${WEB_COMMANDS.SETTINGS}`, {
    description: "Configure web API providers and API keys",
    handler: async (_args, ctx) => {
      await showSettingsDialog(ctx);
    },
  });

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
