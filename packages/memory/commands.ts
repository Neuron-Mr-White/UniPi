/**
 * @unipi/memory — Command registration
 *
 * User-facing commands for memory management.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MemoryStorage } from "./storage.js";

/**
 * Register memory commands.
 */
export function registerMemoryCommands(
  pi: ExtensionAPI,
  getStorage: (global?: boolean) => MemoryStorage
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

      const storage = getStorage(false);
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

      const storage = getStorage(false);
      const deleted = storage.deleteByTitle(args.trim());

      ctx.ui.notify(
        deleted
          ? `Deleted memory: ${args}`
          : `Memory not found: ${args}`,
        "info"
      );
    },
  });

  // --- /unipi:global-memory-process ---
  pi.registerCommand("unipi:global-memory-process", {
    description: "Analyze text and store to global memory",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:global-memory-process <text to analyze>", "info");
        return;
      }

      ctx.ui.notify(
        "Analyzing text for global memories... Use global_memory_store tool to save.",
        "info"
      );

      pi.sendUserMessage(
        `Analyze the following text and extract any memory-worthy items that apply across ALL projects (user preferences, general patterns). For each item, use the global_memory_store tool to save it.\n\nText to analyze:\n${args}`,
        { deliverAs: "followUp" }
      );
    },
  });

  // --- /unipi:global-memory-search ---
  pi.registerCommand("unipi:global-memory-search", {
    description: "Search global memories",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /unipi:global-memory-search <search term>", "info");
        return;
      }

      const storage = getStorage(true);
      const results = storage.search(args.trim());

      if (results.length === 0) {
        ctx.ui.notify(`No global memories found for: "${args}"`, "info");
        return;
      }

      const output = results
        .map(
          (r, i) =>
            `${i + 1}. [${r.record.project}] ${r.record.title} (${r.record.type})\n   ${r.snippet}`
        )
        .join("\n\n");

      ctx.ui.notify(
        `Found ${results.length} global memories:\n\n${output}`,
        "info"
      );
    },
  });

  // --- /unipi:global-memory-list ---
  pi.registerCommand("unipi:global-memory-list", {
    description: "List all global memories with project prefixes",
    handler: async (args, ctx) => {
      const storage = getStorage(true);
      const memories = storage.listAll();

      if (memories.length === 0) {
        ctx.ui.notify("No global memories stored.", "info");
        return;
      }

      const output = memories
        .map((m) => `- [${m.id}] ${m.title} (${m.type})`)
        .join("\n");

      ctx.ui.notify(
        `Global memories (${memories.length}):\n\n${output}`,
        "info"
      );
    },
  });
}
