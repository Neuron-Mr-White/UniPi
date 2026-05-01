/**
 * @unipi/web-api — Extension entry
 *
 * Web search, read, and summarize tools with provider-based backend selection.
 * Provides agent tools: web-search, multi-web-content-read, web-llm-summarize
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import { registerWebTools, WEB_TOOLS } from "./tools.js";
import { registerWebCommands, WEB_COMMANDS } from "./commands.js";
import { webCache } from "./cache.js";
import { loadConfig, loadSmartFetchSettings } from "./settings.js";
import { checkDependencies } from "./engine/dependencies.js";
import "./providers/duckduckgo.js";
import "./providers/jina-search.js";
import "./providers/jina-reader.js";
import "./providers/serpapi.js";
import "./providers/tavily.js";
import "./providers/firecrawl.js";
import "./providers/perplexity.js";
import "./providers/llm-summarize.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

// Get info registry from global (avoids direct import issues with pi's extension loading)
function getInfoRegistry() {
  const g = globalThis as any;
  return g.__unipi_info_registry;
}

export default function (pi: ExtensionAPI) {
  // Register skills directory
  const skillsDir = new URL("../skills", import.meta.url).pathname;
  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Register tools and commands
  registerWebTools(pi);
  registerWebCommands(pi);

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    // Clean expired cache entries on startup
    webCache.clearExpired();

    // Announce module (for subagent integration)
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.WEB_API,
      version: VERSION,
      commands: [
        `unipi:${WEB_COMMANDS.SETTINGS}`,
        `unipi:${WEB_COMMANDS.CACHE_CLEAR}`,
      ],
      tools: [
        WEB_TOOLS.SEARCH,
        WEB_TOOLS.READ,
        WEB_TOOLS.SUMMARIZE,
      ],
    });

    // Register info group
    const registry = getInfoRegistry();
    if (registry) {
      registry.registerGroup({
        id: "web-api",
        name: "Web API",
        icon: "🌐",
        priority: 50,
        config: {
          showByDefault: true,
          stats: [
            { id: "providers", label: "Enabled Providers", show: true },
            { id: "smartFetch", label: "Smart-Fetch", show: true },
            { id: "cacheEntries", label: "Cache Entries", show: true },
            { id: "cacheSize", label: "Cache Size", show: true },
            { id: "expired", label: "Expired Entries", show: true },
          ],
        },
        dataProvider: async () => {
          const config = loadConfig();
          const stats = webCache.getStats();
          const enabledCount = Object.values(config.providers).filter(
            (p) => p.enabled
          ).length;

          // Check smart-fetch engine availability
          const deps = await checkDependencies();
          const smartFetchStatus = deps.available ? "✓ Ready" : `Missing: ${deps.missing.join(", ")}`;

          return {
            providers: { value: String(enabledCount) },
            smartFetch: { value: smartFetchStatus },
            cacheEntries: { value: String(stats.totalEntries) },
            cacheSize: { value: `${(stats.totalSizeBytes / 1024).toFixed(1)} KB` },
            expired: { value: String(stats.expiredEntries) },
          };
        },
      });
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Cleanup: clear expired cache entries
    webCache.clearExpired();
  });
}
