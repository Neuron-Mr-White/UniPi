/**
 * commands.ts — CocoIndex command registration
 *
 * Exposes cocoindex operations as Pi commands:
 * - /unipi:cocoindex-update  — Run indexing
 * - /unipi:cocoindex-status  — Show status
 * - /unipi:cocoindex-init    — Scaffold pipeline
 * - /unipi:cocoindex-settings — TUI settings
 *
 * Commands are registered at extension load time (synchronous).
 * Project directory is resolved from ctx.cwd at handler invocation time.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { COCOINDEX_COMMANDS, COCOINDEX_PACKAGE_SPEC } from "@pi-unipi/core";
import * as bridge from "./bridge.js";
import { ensureCocoindex } from "./installer.js";

export function registerCocoindexCommands(pi: ExtensionAPI): void {
  // ── /unipi:cocoindex-update ────────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.UPDATE}`, {
    description: "Run CocoIndex update to index the current project",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const projectDir = (ctx as any).cwd ?? process.cwd();
      const ensured = await ensureCocoindex(ctx);
      if (!ensured.ok) return;

      const pipelineDir = bridge.getPipelineDir(projectDir);
      const initialized = await bridge.isPipelineInitialized(pipelineDir);
      if (!initialized) {
        ctx.ui.notify("⚠️ Pipeline not initialized. Run /unipi:cocoindex-init first.", "warning");
        return;
      }

      ctx.ui.notify("🔄 Running CocoIndex update...", "info");

      const result = await bridge.indexProject(projectDir);
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
      const projectDir = (ctx as any).cwd ?? process.cwd();
      const info = await bridge.status(projectDir);
      const lines = [
        "📦 CocoIndex Status",
        `CLI: ${info.cliAvailable ? "✅ installed" : "❌ not found"}`,
        `Pipeline: ${info.pipelineConfigured ? "✅ configured" : "❌ not initialized"}`,
        `Target: ${info.targetStore}`,
        `Data: ${info.indexed ? `✅ ${info.docCount} documents` : "— no data"}`,
        `Last run: ${info.lastRun ?? "never"}`,
      ];

      if (!info.cliAvailable) {
        lines.push(
          "",
          "Setup: run /unipi:cocoindex-init for guided install.",
          `Manual: uv tool install '${COCOINDEX_PACKAGE_SPEC}'`,
          "Fallback: mise use -g uv@latest",
        );
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
      const projectDir = (ctx as any).cwd ?? process.cwd();
      const ensured = await ensureCocoindex(ctx);
      if (!ensured.ok) return;

      const result = await bridge.initPipeline(projectDir);
      if (result.success) {
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

  // ── /unipi:cocoindex-search ──────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.SEARCH}`, {
    description: "Search indexed codebase with semantic vector search",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const projectDir = (ctx as any).cwd ?? process.cwd();
      const query = args.trim();

      if (!query) {
        ctx.ui.notify("Usage: /unipi:cocoindex-search <query>", "warning");
        return;
      }

      const pipelineDir = bridge.getPipelineDir(projectDir);
      const lancedbPath = bridge.getPipelineDir(projectDir) + "/.lancedb";
      const { existsSync } = await import("fs");
      if (!existsSync(lancedbPath)) {
        ctx.ui.notify("❌ No index found. Run /unipi:cocoindex-update first.", "error");
        return;
      }

      ctx.ui.notify(`🔍 Searching: "${query}"...`, "info");

      try {
        const results = await bridge.search(projectDir, query, { limit: 10 });

        if (results.length === 0) {
          ctx.ui.notify(`No results for "${query}".`, "info");
          return;
        }

        const lines = results.map((r, i) => {
          const dist = r.rank != null ? ` (${r.rank.toFixed(3)})` : "";
          const file = r.source || r.title;
          const snippet = r.content.slice(0, 150).replace(/\n/g, " ");
          return `${i + 1}. ${file}${dist}\n   ${snippet}...`;
        });
        ctx.ui.notify(
          `🔍 ${results.length} results for "${query}":\n\n${lines.join("\n\n")}`,
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`❌ Search failed: ${err.message}`, "error");
      }
    },
  });

  // ── /unipi:cocoindex-settings ──────────────────────────
  pi.registerCommand(`unipi:${COCOINDEX_COMMANDS.SETTINGS}`, {
    description: "Show CocoIndex configuration and settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const projectDir = (ctx as any).cwd ?? process.cwd();
      const pipelineDir = bridge.getPipelineDir(projectDir);
      const info = await bridge.status(projectDir);
      const lines = [
        "⚙️ CocoIndex Settings",
        "",
        `Pipeline: ${pipelineDir}/main.py`,
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
