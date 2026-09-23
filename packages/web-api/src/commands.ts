/**
 * @unipi/web-api — Hub action runners
 *
 * "Clear web cache" lives in /unipi:settings (Web API group). There are no
 * slash commands in this package.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCommandRunner } from "@pi-unipi/core";
import { webCache } from "./cache.js";

/**
 * Register hub action runners with pi.
 */
export function registerWebCommands(pi: ExtensionAPI): void {
  // "Clear web cache" — confirm, then drop every cached entry.
  registerCommandRunner("unipi:web-cache-clear", async (rawCtx: unknown) => {
    const ctx = rawCtx as ExtensionCommandContext;
    const stats = webCache.getStats();
    const ok = await ctx.ui.confirm(
      "Clear web cache?",
      `${stats.totalSizeBytes} bytes cached. This cannot be undone.`,
    );
    if (!ok) return;
    const cleared = webCache.clear();
    ctx.ui.notify(
      `Cache cleared: ${cleared} entries removed (${stats.totalSizeBytes} bytes freed)`,
      "info",
    );
  });
}
