/**
 * commands.ts — CocoIndex command registration
 *
 * Exposes cocoindex operations as Pi commands:
 * - /unipi:cocoindex-update  — Run indexing
 * - /unipi:cocoindex-status  — Show status
 * - /unipi:cocoindex-init    — Scaffold pipeline
 * - /unipi:cocoindex-settings — TUI settings
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { COCOINDEX_COMMANDS } from "@pi-unipi/core";
import * as bridge from "./bridge.js";
import type { CocoindexDeps } from "./bridge.js";

export function registerCocoindexCommands(pi: ExtensionAPI, deps: CocoindexDeps): void {
  // ── /unipi:cocoindex-update ────────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.UPDATE}`, {
    description: "Run CocoIndex update to index the current project",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const available = await bridge.isAvailable();
      if (!available) {
        ctx.ui.notify(
          "❌ CocoIndex CLI not found. Install with:\n" +
          "  pip install cocoindex\n" +
          "  pip install 'cocoindex[lancedb]'", "error");
        return;
      }

      if (!deps.initialized) {
        ctx.ui.notify("⚠️ Pipeline not initialized. Run /unipi:cocoindex-init first.", "warning");
        return;
      }

      ctx.ui.notify("🔄 Running CocoIndex update...", "info");

      const result = await bridge.indexProject(deps.projectDir);
      if (result.success) {
        ctx.ui.notify(
          `✅ CocoIndex update complete: ${result.chunksProcessed} chunks in ${(result.durationMs / 1000).toFixed(1)}s`,
          "info",
        );
      } else {
        ctx.ui.notify(`❌ CocoIndex update failed: ${result.error}`, "error");
      }
    },
  });

  // ── /unipi:cocoindex-status ────────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.STATUS}`, {
    description: "Show CocoIndex indexing status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const info = await bridge.status(deps.projectDir);
      const lines = [
        "📦 CocoIndex Status",
        `CLI: ${info.cliAvailable ? "✅ installed" : "❌ not found"}`,
        `Pipeline: ${info.pipelineConfigured ? "✅ configured" : "❌ not initialized"}`,
        `Target: ${info.targetStore}`,
        `Data: ${info.indexed ? `✅ ${info.docCount} documents` : "— no data"}`,
        `Last run: ${info.lastRun ?? "never"}`,
      ];

      if (!info.cliAvailable) {
        lines.push("", "Setup: pip install cocoindex");
      }
      if (!info.pipelineConfigured) {
        lines.push("", "Initialize: /unipi:cocoindex-init");
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /unipi:cocoindex-init ──────────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.INIT}`, {
    description: "Initialize CocoIndex pipeline for the current project",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const result = await bridge.initPipeline(deps.projectDir);
      if (result.success) {
        deps.initialized = true;
        ctx.ui.notify(
          "✅ CocoIndex pipeline initialized at .unipi/cocoindex/main.py\n" +
          "Run /unipi:cocoindex-update to start indexing.",
          "info",
        );
      } else {
        ctx.ui.notify(`❌ Init failed: ${result.error}`, "error");
      }
    },
  });

  // ── /unipi:cocoindex-settings ──────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.SETTINGS}`, {
    description: "Show CocoIndex configuration and settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const info = await bridge.status(deps.projectDir);
      const lines = [
        "⚙️ CocoIndex Settings",
        "",
        `Pipeline: ${deps.pipelineDir}/main.py`,
        `Target store: ${info.targetStore}`,
        `Embedding model: (from memory config)`,
        "",
        "Configuration:",
        "  • Pipeline file: .unipi/cocoindex/main.py",
        "  • Data store: .unipi/cocoindex/.lancedb/",
        "  • Embedding config: ~/.unipi/memory/config.json",
        "",
        "To customize, edit .unipi/cocoindex/main.py directly.",
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
