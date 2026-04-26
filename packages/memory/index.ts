/**
 * @unipi/memory — Extension entry
 *
 * Persistent cross-session memory with vector search.
 * All storage is project-scoped. "Global" tools search across all projects.
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

// Get info registry from global (avoids direct import issues with pi's extension loading)
function getInfoRegistry() {
  const g = globalThis as any;
  return g.__unipi_info_registry;
}
import {
  MemoryStorage,
  getProjectName,
  searchAllProjects,
  listAllProjects,
} from "./storage.js";
import { registerMemoryTools, MEMORY_TOOLS } from "./tools.js";
import { registerMemoryCommands } from "./commands.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Storage instance for current project */
let projectStorage: MemoryStorage | null = null;

/**
 * Get storage for the current project.
 */
function getStorage(): MemoryStorage {
  if (!projectStorage) {
    // Fallback: create new instance (shouldn't happen after session_start)
    return new MemoryStorage("unknown");
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
    projectStorage = new MemoryStorage(projectName);
    projectStorage.init();

    // Announce module
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.MEMORY,
      version: VERSION,
      commands: [
        "unipi:memory-process",
        "unipi:memory-search",
        "unipi:memory-consolidate",
        "unipi:memory-forget",
        "unipi:global-memory-search",
        "unipi:global-memory-list",
      ],
      tools: [
        MEMORY_TOOLS.STORE,
        MEMORY_TOOLS.SEARCH,
        MEMORY_TOOLS.DELETE,
        MEMORY_TOOLS.LIST,
        MEMORY_TOOLS.GLOBAL_SEARCH,
        MEMORY_TOOLS.GLOBAL_LIST,
      ],
    });

    // Register info group
    const registry = getInfoRegistry();
    if (registry) {
      console.debug("[memory] Registering info group");
      registry.registerGroup({
        id: "memory",
        name: "Memory",
        icon: "🧠",
        priority: 60,
        config: {
          showByDefault: true,
          stats: [
            { id: "projectCount", label: "Project Memories", show: true },
            { id: "totalCount", label: "Total Memories", show: true },
            { id: "projects", label: "Projects", show: true },
            { id: "recent", label: "Recent Memories", show: true },
          ],
        },
        dataProvider: async () => {
          if (!projectStorage) {
            return {
              projectCount: { value: "0" },
              totalCount: { value: "0" },
              projects: { value: "none" },
              recent: { value: "none" },
            };
          }

          const projectMemories = projectStorage.listAll();
          const allMemories = listAllProjects();
          const uniqueProjects = [...new Set(allMemories.map((m) => m.project))];

          // Get 3 most recent memories (sorted by updated DESC in listAll)
          const recentMemories = projectMemories.slice(0, 3);
          const recentList = recentMemories.map(m => m.title).join("\n");

          return {
            projectCount: { value: String(projectMemories.length) },
            totalCount: { value: String(allMemories.length) },
            projects: {
              value: uniqueProjects.length.toString(),
              detail: uniqueProjects.slice(0, 5).join(", ") + (uniqueProjects.length > 5 ? ` +${uniqueProjects.length - 5} more` : ""),
            },
            recent: {
              value: recentMemories.length > 0 ? recentMemories[0].title : "none",
              detail: recentMemories.length > 1 ? recentMemories.slice(1).map(m => m.title).join("\n") : undefined,
            },
          };
        },
      });
    }

    // Show memory status in UI
    if (ctx.hasUI) {
      const projectCount = projectStorage.listAll().length;
      const allMemories = listAllProjects();
      const projectCountAll = allMemories.length;
      ctx.ui.setStatus(
        "unipi-memory",
        `🧠 memory ${projectCount}p/${projectCountAll}all`
      );
    }
  });

  // Inject memory titles at session start
  pi.on("before_agent_start", async (event, ctx) => {
    if (!projectStorage) return;

    const projectName = getProjectName(ctx.cwd);
    const projectMemories = projectStorage.listAll();

    if (projectMemories.length === 0) {
      return; // No memories to inject
    }

    let injection = "\n\n<memory>\n";
    injection += `Available memories for project "${projectName}":\n\n`;

    // Project memories
    for (const m of projectMemories) {
      injection += `- ${m.title}\n`;
    }

    injection += "\nUse memory_search to retrieve full content. Use memory_store to save new memories.\n";
    injection += "Use global_memory_search to search across ALL projects.\n";
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
    projectStorage = null;
  });
}
