/**
 * @unipi/memory — Extension entry
 *
 * Persistent cross-session memory with vector search.
 * Provides tools and commands for memory management.
 * Injects memory titles at session start.
 * Auto-consolidates on compaction.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  emitEvent,
  getPackageVersion,
} from "@unipi/core";
import { MemoryStorage, getProjectName } from "./storage.js";
import { registerMemoryTools, MEMORY_TOOLS } from "./tools.js";
import { registerMemoryCommands } from "./commands.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Storage instances */
let projectStorage: MemoryStorage | null = null;
let globalStorage: MemoryStorage | null = null;

/**
 * Get or create storage for the current project.
 */
function getStorage(globalScope = false): MemoryStorage {
  if (globalScope) {
    if (!globalStorage) {
      globalStorage = new MemoryStorage("global", true);
      globalStorage.init();
    }
    return globalStorage;
  }

  if (!projectStorage) {
    // Fallback to global if somehow called before init
    return getStorage(true);
  }

  return projectStorage;
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
  registerMemoryTools(pi, getStorage);
  registerMemoryCommands(pi, getStorage);

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    // Initialize project storage
    const projectName = getProjectName(ctx.cwd);
    projectStorage = new MemoryStorage(projectName, false);
    projectStorage.init();

    // Initialize global storage
    globalStorage = new MemoryStorage("global", true);
    globalStorage.init();

    // Announce module
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.MEMORY,
      version: VERSION,
      commands: [
        "unipi:memory-process",
        "unipi:memory-search",
        "unipi:memory-consolidate",
        "unipi:memory-forget",
        "unipi:global-memory-process",
        "unipi:global-memory-search",
        "unipi:global-memory-list",
      ],
      tools: [
        MEMORY_TOOLS.STORE,
        MEMORY_TOOLS.SEARCH,
        MEMORY_TOOLS.DELETE,
        MEMORY_TOOLS.LIST,
        MEMORY_TOOLS.GLOBAL_STORE,
        MEMORY_TOOLS.GLOBAL_SEARCH,
        MEMORY_TOOLS.GLOBAL_LIST,
      ],
    });

    // Show memory status in UI
    if (ctx.hasUI) {
      const projectCount = projectStorage.listAll().length;
      const globalCount = globalStorage.listAll().length;
      ctx.ui.setStatus(
        "unipi-memory",
        `🧠 memory ${projectCount}p/${globalCount}g`
      );
    }
  });

  // Inject memory titles at session start
  pi.on("before_agent_start", async (event, ctx) => {
    if (!projectStorage || !globalStorage) return;

    const projectName = getProjectName(ctx.cwd);
    const projectMemories = projectStorage.listAll();
    const globalMemories = globalStorage.listAll();

    if (projectMemories.length === 0 && globalMemories.length === 0) {
      return; // No memories to inject
    }

    let injection = "\n\n<memory>\n";
    injection += "Available memories for context and recall:\n\n";

    // Project memories
    if (projectMemories.length > 0) {
      injection += `Project memories (${projectName}):\n`;
      for (const m of projectMemories) {
        injection += `- ${m.title}\n`;
      }
      injection += "\n";
    }

    // Global memories
    if (globalMemories.length > 0) {
      injection += "Global memories:\n";
      for (const m of globalMemories) {
        injection += `- [global] ${m.title}\n`;
      }
      injection += "\n";
    }

    injection += "Use memory_search to retrieve full content. Use memory_store to save new memories.\n";
    injection += "</memory>";

    return {
      systemPrompt: event.systemPrompt + injection,
    };
  });

  // Auto-consolidation on compaction
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation } = event;

    // Extract summary text
    const summary = preparation.previousSummary || "";

    if (!summary || summary.length < 100) {
      // Summary too short to extract memories from
      return;
    }

    // For now, just log that consolidation would happen
    // Future: Use LLM to extract memories
    console.log("[unipi/memory] Auto-consolidation triggered, summary length:", summary.length);

    // Don't modify the compaction summary - return unchanged
    return {};
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    projectStorage?.close();
    globalStorage?.close();
    projectStorage = null;
    globalStorage = null;
  });
}
