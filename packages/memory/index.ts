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
} from "@pi-unipi/core";

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
import { registerMemoryTools, MEMORY_TOOLS, GLOBAL_SEARCH_ALIAS } from "./tools.js";
import { registerMemoryCommands } from "./commands.js";
import { isEmbeddingReady, hasModelChanged } from "./settings.js";

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
  // Lifecycle state — tracks whether recall/store have happened this session
  let recallDone = false;
  let storeDone = false;

  // Register skills directory
  const skillsDir = new URL("./skills", import.meta.url).pathname;
  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Register tools and commands
  registerMemoryTools(pi, getStorage, () => { recallDone = true; storeDone = true; });
  registerMemoryCommands(pi, getStorage);

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    // Reset lifecycle flags
    recallDone = false;
    storeDone = false;

    // Initialize project storage
    const projectName = getProjectName(ctx.cwd);
    projectStorage = new MemoryStorage(projectName);
    try {
      projectStorage.init();
      
      // Sync any orphaned markdown files into the database
      const synced = projectStorage.syncOrphanedFiles();
      if (synced > 0) {
        console.warn(`[unipi/memory] Synced ${synced} orphaned memory files into database`);
      }
    } catch (err) {
      console.warn("[unipi/memory] Failed to initialize storage, running without memory:", (err as any)?.message ?? err);
      projectStorage = null;
    }


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
        "unipi:memory-settings",
      ],
      tools: [
        MEMORY_TOOLS.STORE,
        MEMORY_TOOLS.SEARCH,
        MEMORY_TOOLS.DELETE,
        MEMORY_TOOLS.LIST,
        GLOBAL_SEARCH_ALIAS,
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

          let projectMemories: Array<{ id: string; title: string; type: string }> = [];
          let allMemories: Array<{ project: string; id: string; title: string; type: string }> = [];
          try {
            projectMemories = projectStorage.listAll();
            allMemories = listAllProjects();
          } catch (err) {
            console.warn("[unipi/memory] Failed to list memories for info panel:", err);
          }
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
      let projectCount = 0;
      let projectCountAll = 0;
      try {
        projectCount = projectStorage?.listAll()?.length ?? 0;
        projectCountAll = listAllProjects().length;
      } catch (err) {
        console.warn("[unipi/memory] Failed to count memories for status:", err);
      }
      const vecReady = isEmbeddingReady();
      const vecIcon = vecReady ? "⚡" : "📝";
      ctx.ui.setStatus(
        "unipi-memory",
        `${vecIcon} memory ${projectCount}p/${projectCountAll}all${hasModelChanged() ? " ⚠" : ""}`
      );
    }
  });

  // Inject memory recall reminder at agent start (hidden message, not system prompt)
  pi.on("before_agent_start", async (event, ctx) => {
    if (recallDone) return;
    if (!projectStorage) return;

    const projectName = getProjectName(ctx.cwd);
    let projectMemories: Array<{ id: string; title: string; type: string }> = [];
    try {
      projectMemories = projectStorage.listAll();
    } catch (err) {
      console.warn("[unipi/memory] Failed to list memories for recall:", err);
      recallDone = true; // Skip recall on error
      return;
    }

    if (projectMemories.length === 0) {
      recallDone = true; // Nothing to recall, skip
      return;
    }

    const titleList = projectMemories.slice(0, 20).map(m => `- ${m.title}`).join("\n");
    const extra = projectMemories.length > 20 ? `\n... and ${projectMemories.length - 20} more` : "";

    return {
      message: {
        customType: "unipi-memory-recall-reminder",
        content: [
          "## 🧠 Memory System Active",
          "",
          `You have ${projectMemories.length} memories stored for project "${projectName}".`,
          "**BEFORE starting work**, call `memory_search` with relevant keywords to check for existing context.",
          "",
          "Available memories:",
          titleList + extra,
          "",
          "**AFTER completing the task**, if you learned something non-obvious,",
          "call `memory_store` to save it for future sessions.",
          "",
          "Guardrails: read max 10 memory results per search. Update existing memories instead of creating duplicates.",
        ].join("\n"),
        display: false,
      },
    };
  });

  // After each agent response, remind LLM to save if it hasn't yet
  pi.on("agent_end", async (_event, _ctx) => {
    if (storeDone || !recallDone) return;

    pi.sendMessage(
      {
        customType: "unipi-memory-retro-reminder",
        content: [
          "**🧠 Memory reminder:** If you learned something non-obvious in this task,",
          "call `memory_store` to save it as a memory for future sessions.",
          "Update existing memories instead of creating duplicates.",
        ].join(" "),
        display: false,
      },
      {
        deliverAs: "nextTurn",
      },
    );
  });

  // After compaction, reset recall state so reminder re-injects
  pi.on("session_compact", async (_event, _ctx) => {
    recallDone = false;
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    projectStorage?.close();
    projectStorage = null;
  });
}
