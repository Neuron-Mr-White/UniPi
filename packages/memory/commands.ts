/**
 * @unipi/memory — Command registration
 *
 * User-facing commands for memory management.
 * All storage is project-scoped. "Global" commands search across all projects.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStorage, searchAllProjects, listAllProjects } from "./storage.js";
import { showMemorySettings } from "./tui/settings-tui.js";
import { isEmbeddingReady, hasModelChanged, loadEmbeddingConfig } from "./settings.js";

/**
 * Register memory commands.
 */
export function registerMemoryCommands(
  pi: ExtensionAPI,
  getStorage: () => MemoryStorage
): void {
  // --- /unipi:memory-process ---
  pi.registerCommand("unipi:memory-process", {
    description: "Analyze text and store extracted memories",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:memory-process <text to analyze>", "info");
        return;
      }

      ctx.ui.notify(
        "Analyzing text for memories... Use memory_store tool to save.",
        "info"
      );

      // Inject instruction for agent to process
      pi.sendUserMessage(
        `Analyze the following text and extract any memory-worthy items (user preferences, project decisions, code patterns, conversation summaries). For each item found, use the memory_store tool to save it.\n\nText to analyze:\n${args}`,
        { deliverAs: "followUp" }
      );
    },
  });

  // --- /unipi:memory-search ---
  pi.registerCommand("unipi:memory-search", {
    description: "Search project memories",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:memory-search <search term>", "info");
        return;
      }

      const storage = getStorage();
      const results = storage.search(args.trim());

      if (results.length === 0) {
        ctx.ui.notify(`No memories found for: "${args}"`, "info");
        return;
      }

      const output = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.record.title} (${r.record.type})\n   ${r.snippet}`
        )
        .join("\n\n");

      ctx.ui.notify(
        `Found ${results.length} memories:\n\n${output}`,
        "info"
      );
    },
  });

  // --- /unipi:memory-consolidate ---
  pi.registerCommand("unipi:memory-consolidate", {
    description: "Consolidate current session into memory",
    handler: async (args, ctx) => {
      ctx.ui.notify(
        "Consolidating session into memory... Use memory_store tool to save insights.",
        "info"
      );

      // Inject instruction for agent to consolidate
      pi.sendUserMessage(
        `Review the current session and identify any memory-worthy items:
- User preferences discovered
- Project decisions made
- Code patterns learned
- Important context to remember

For each item, use the memory_store tool to save it with an appropriate title and type.`,
        { deliverAs: "followUp" }
      );
    },
  });

  // --- /unipi:memory-forget ---
  pi.registerCommand("unipi:memory-forget", {
    description: "Delete a memory by title",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:memory-forget <memory title>", "info");
        return;
      }

      const storage = getStorage();
      const deleted = storage.deleteByTitle(args.trim());

      ctx.ui.notify(
        deleted
          ? `Deleted memory: ${args}`
          : `Memory not found: ${args}`,
        "info"
      );
    },
  });

  // --- /unipi:global-memory-search ---
  pi.registerCommand("unipi:global-memory-search", {
    description: "Search memories across all projects",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:global-memory-search <search term>", "info");
        return;
      }

      const results = searchAllProjects(args.trim());

      if (results.length === 0) {
        ctx.ui.notify(`No memories found across projects for: "${args}"`, "info");
        return;
      }

      const output = results
        .map(
          (r, i) =>
            `${i + 1}. [${r.record.project}] ${r.record.title} (${r.record.type})\n   ${r.snippet}`
        )
        .join("\n\n");

      ctx.ui.notify(
        `Found ${results.length} memories across projects:\n\n${output}`,
        "info"
      );
    },
  });

  // --- /unipi:global-memory-list ---
  pi.registerCommand("unipi:global-memory-list", {
    description: "List all memories across all projects",
    handler: async (args, ctx) => {
      const memories = listAllProjects();

      if (memories.length === 0) {
        ctx.ui.notify("No memories stored in any project.", "info");
        return;
      }

      // Group by project
      const grouped = new Map<string, typeof memories>();
      for (const m of memories) {
        const list = grouped.get(m.project) || [];
        list.push(m);
        grouped.set(m.project, list);
      }

      let output = "";
      for (const [project, projectMemories] of grouped) {
        output += `\n${project} (${projectMemories.length}):\n`;
        for (const m of projectMemories) {
          output += `  - ${m.title} (${m.type})\n`;
        }
      }

      ctx.ui.notify(
        `All memories across ${grouped.size} projects (${memories.length} total):${output}`,
        "info"
      );
    },
  });

  // --- /unipi:memory-settings ---
  pi.registerCommand("unipi:memory-settings", {
    description: "Configure embedding provider and model for vector search",
    handler: async (_args, ctx) => {
      // Quick status if called with no TUI
      if (!ctx.hasUI) {
        const config = loadEmbeddingConfig();
        const ready = isEmbeddingReady();
        const migrated = hasModelChanged();
        ctx.ui.notify(
          `Embedding: ${ready ? "✓ Ready" : "✗ Not configured"}\n` +
          `Provider: ${config.provider}\n` +
          `Model: ${config.model}\n` +
          `Dimensions: ${config.dimensions}\n` +
          (migrated ? "⚠ Model changed — re-embed needed" : ""),
          "info"
        );
        return;
      }

      await showMemorySettings(pi);
    },
  });
}
