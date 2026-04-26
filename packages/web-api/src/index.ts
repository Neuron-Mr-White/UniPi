/**
 * @unipi/web-api — Extension entry
 *
 * Web search, read, and summarize tools with provider-based backend selection.
 * Provides agent tools: web-search, web-read, web-llm-summarize
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
import { loadConfig } from "./settings.js";
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
  const skillsDir = new URL("./skills", import.meta.url).pathname;
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
        getData: async () => {
          const config = loadConfig();
          const stats = webCache.getStats();
          const enabledCount = Object.values(config.providers).filter(
            (p) => p.enabled
          ).length;

          return {
            "Enabled Providers": enabledCount,
            "Cache Entries": stats.totalEntries,
            "Cache Size": `${(stats.totalSizeBytes / 1024).toFixed(1)} KB`,
            "Expired Entries": stats.expiredEntries,
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
