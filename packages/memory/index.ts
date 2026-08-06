/**
 * @unipi/memory — Extension entry
 *
 * Persistent cross-session memory with vector search.
 * All storage is project-scoped. "Global" tools search across all projects.
 * Injects memory titles at session start.
 * Auto-consolidates on compaction.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";

// Get info registry from global (avoids direct import issues with pi's extension loading)
function getInfoRegistry() {
  return globalThis.__unipi_info_registry;
}
import {
  MemoryStorage,
  getProjectName,
  searchAllProjects,
  listAllProjectsCachedAsync,
  invalidateAllProjectsCache,
} from "./storage.js";
import { registerMemoryTools, MEMORY_TOOLS, GLOBAL_SEARCH_ALIAS } from "./tools.js";
import { registerMemoryCommands } from "./commands.js";
import { isEmbeddingReady, hasModelChanged } from "./settings.js";

/** Package version */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Storage instance for current project */
let projectStorage: MemoryStorage | null = null;

/**
 * Whether orphaned-file sync still owes this session a run.
 *
 * The sync spawns a Python bridge (~0.5s). Running it in session_start delayed
 * every startup for a job that only matters once memory is actually used, so it
 * is deferred to the first storage access instead.
 */
let orphanSyncPending = false;

/** Run the deferred orphaned-file sync exactly once per session. */
function ensureOrphanSync(storage: MemoryStorage): void {
  if (!orphanSyncPending) return;
  orphanSyncPending = false;
  try {
    storage.syncOrphanedFiles();
  } catch {
    // Sync failure must not break the tool call that triggered it.
  }
}

/**
 * Get storage for the current project.
 */
function getStorage(): MemoryStorage {
  if (!projectStorage) {
    // Fallback: create new instance (shouldn't happen after session_start)
    return new MemoryStorage("unknown");
  }
  // Any real use of memory picks up markdown files added out of band.
  ensureOrphanSync(projectStorage);
  return projectStorage;
}

export default function (pi: ExtensionAPI) {
  // Lifecycle state — tracks whether recall/store have happened this session
  let recallDone = false;
  let storeDone = false;

  // Register tools and commands
  registerMemoryTools(pi, getStorage, {
    onRecall: () => { recallDone = true; },
    onStore: () => {
      storeDone = true;
      // Fires on store and delete; drop the cached cross-project counts so
      // the info overlay reflects the write.
      invalidateAllProjectsCache();
    },
  });
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

      // Orphaned markdown files are synced lazily on first storage access
      // (see ensureOrphanSync) — the Python bridge spawn is too slow to run
      // on the startup path, and nothing reads the result until memory is used.
      orphanSyncPending = true;
    } catch (_err) {
      // Memory init failure — running without memory. Silent startup.
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
            // Async twins: the MemPalace backend spawns Python, which would
            // otherwise block the UI while the overlay is open.
            projectMemories = await projectStorage.listAllAsync();
            allMemories = await listAllProjectsCachedAsync();
          } catch (_err) {
            // Info panel data unavailable — shows empty values.
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

    // Show memory status in UI.
    //
    // Both counts come from the Python MemPalace bridge (~1.5s combined) and
    // only produce a status-bar string, so they are resolved after startup and
    // the status is filled in when they land. Blocking session_start on them
    // delayed the whole extension chain.
    if (ctx.hasUI) {
      const mempalaceActive = projectStorage?.isMempalace() ?? false;
      const backendIcon = mempalaceActive ? "🧠" : (isEmbeddingReady() ? "⚡" : "📝");
      const warn = hasModelChanged() ? " ⚠" : "";
      const setStatus = (counts: string) =>
        ctx.ui.setStatus("unipi-memory", `${backendIcon} mem ${counts}${warn}`);

      setStatus("…");
      void (async () => {
        let projectCount = 0;
        let projectCountAll = 0;
        try {
          projectCount = (await projectStorage?.listAllAsync())?.length ?? 0;
          projectCountAll = (await listAllProjectsCachedAsync()).length;
        } catch (_err) {
          // Count unavailable — status bar shows 0.
        }
        setStatus(`${projectCount}p/${projectCountAll}all`);
      })();
    }
  });

  // Inject memory recall reminder at agent start (hidden message, not system prompt)
  pi.on("before_agent_start", async (_event, ctx) => {
    if (recallDone) return;
    if (!projectStorage) return;

    // Workflow sandboxes and user presets can change the active tool set. Only
    // instruct the agent to use memory tools that are actually callable now.
    const activeTools = new Set(pi.getActiveTools());
    const canSearch = activeTools.has(MEMORY_TOOLS.SEARCH) || activeTools.has(GLOBAL_SEARCH_ALIAS);
    const canStore = activeTools.has(MEMORY_TOOLS.STORE);

    if (!canSearch && !canStore) {
      recallDone = true;
      storeDone = true;
      return;
    }

    const projectName = getProjectName(ctx.cwd);
    let projectMemories: Array<{ id: string; title: string; type: string }> = [];
    try {
      projectMemories = projectStorage.listAll();
    } catch (_err) {
      recallDone = true; // Skip recall on error
      return;
    }

    if (projectMemories.length === 0 && !canStore) {
      recallDone = true; // Nothing to recall and no store tool available
      return;
    }

    const lines = [
      "## 🧠 Memory System Active",
      "",
      `You have ${projectMemories.length} memories stored for project "${projectName}".`,
    ];

    if (canSearch && projectMemories.length > 0) {
      const titleList = projectMemories.slice(0, 20).map(m => `- ${m.title}`).join("\n");
      const extra = projectMemories.length > 20 ? `\n... and ${projectMemories.length - 20} more` : "";
      lines.push(
        "**BEFORE starting work**, call `memory_search` with relevant keywords to check for existing context.",
        "",
        "Available memories:",
        titleList + extra,
      );
    } else {
      recallDone = true;
    }

    if (canStore) {
      lines.push(
        "",
        "**AFTER completing the task**, if you learned something non-obvious,",
        "call `memory_store` to save it for future sessions.",
      );
    } else {
      storeDone = true;
    }

    lines.push(
      "",
      "Guardrails: read max 10 memory results per search. Update existing memories instead of creating duplicates.",
    );

    return {
      message: {
        customType: "unipi-memory-recall-reminder",
        content: lines.join("\n"),
        display: false,
      },
    };
  });

  // After each agent response, remind LLM to save if it hasn't yet
  pi.on("agent_end", async (_event, _ctx) => {
    if (storeDone || !recallDone) return;
    if (!pi.getActiveTools().includes(MEMORY_TOOLS.STORE)) return;

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
