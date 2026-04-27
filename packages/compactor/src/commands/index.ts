/**
 * All /unipi:compact-* commands
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig } from "../config/manager.js";
import { applyPreset, parsePreset } from "../config/presets.js";
import { getLastCompactionStats } from "../compaction/hooks.js";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("compact", {
    description: "Show compaction stats",
    handler: async (_args: string, ctx: any) => {
      const stats = getLastCompactionStats();
      ctx.ui.notify(
        stats
          ? `compactor: ${stats.summarized} summarized, ${stats.kept} kept (~${stats.keptTokensEst} tok)`
          : "compactor: No compaction stats yet. Trigger /compact to run.",
        "info",
      );
    },
  });

  pi.registerCommand("compact-recall", {
    description: "Search session history",
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify(`compactor: Use vcc_recall tool for session search. Query: "${args}"`, "info");
    },
  });

  pi.registerCommand("compact-stats", {
    description: "Show context savings dashboard",
    handler: async (_args: string, ctx: any) => {
      const stats = getLastCompactionStats();
      ctx.ui.notify(
        stats
          ? `compactor stats: ${stats.summarized} summarized | ${stats.kept} kept | ~${stats.keptTokensEst} tokens`
          : "compactor: No stats yet.",
        "info",
      );
    },
  });

  pi.registerCommand("compact-doctor", {
    description: "Run diagnostics",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify("compactor: Run ctx_doctor tool for full diagnostics.", "info");
    },
  });

  pi.registerCommand("compact-settings", {
    description: "Open TUI settings overlay",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify("compactor: Settings overlay not yet implemented in TUI.", "warning");
    },
  });

  pi.registerCommand("compact-preset", {
    description: "Apply quick preset",
    handler: async (args: string, ctx: any) => {
      const presetName = parsePreset(args.trim());
      if (!presetName) {
        ctx.ui.notify("compactor: Unknown preset. Use: opencode, balanced, verbose, minimal", "error");
        return;
      }
      const config = applyPreset(presetName);
      const result = saveConfig(config);
      if (result.success) {
        ctx.ui.notify(`compactor: Applied '${presetName}' preset.`, "info");
      } else {
        ctx.ui.notify(`compactor: Failed to save preset: ${result.error}`, "error");
      }
    },
  });

  pi.registerCommand("compact-index", {
    description: "Index current project",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify("compactor: Use ctx_index tool to index content.", "info");
    },
  });

  pi.registerCommand("compact-search", {
    description: "Search indexed content",
    handler: async (args: string, ctx: any) => {
      ctx.ui.notify(`compactor: Use ctx_search tool. Query: "${args}"`, "info");
    },
  });

  pi.registerCommand("compact-purge", {
    description: "Wipe all indexed content",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify("compactor: Use ctx_doctor or manually delete ~/.unipi/db/compactor/", "warning");
    },
  });
}
