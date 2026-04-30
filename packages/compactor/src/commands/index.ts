/**
 * All /unipi:compact-* commands
 *
 * Commands perform real work by calling tool implementations directly.
 * Dependencies (sessionDB, contentStore, sessionId) are injected at registration time.
 *
 * New command names (v0.2.0):
 *   /unipi:session-recall (was /unipi:compact-recall)
 *   /unipi:content-index (was /unipi:compact-index)
 *   /unipi:content-search (was /unipi:compact-search)
 *   /unipi:content-purge (was /unipi:compact-purge)
 *
 * Old names kept as deprecated aliases for backward compatibility.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig } from "../config/manager.js";
import { applyPreset, parsePreset } from "../config/presets.js";
import { getLastCompactionStats } from "../compaction/hooks.js";
import { compactTool } from "../tools/compact.js";
import { vccRecall } from "../tools/vcc-recall.js";
import { ctxStats } from "../tools/ctx-stats.js";
import { ctxDoctor } from "../tools/ctx-doctor.js";
import { ctxSearch } from "../tools/ctx-search.js";
import { ContentStore } from "../store/index.js";
import type { SessionDB } from "../session/db.js";
import type { NormalizedBlock, RuntimeCounters } from "../types.js";

export interface CommandDeps {
  sessionDB: SessionDB | null;
  contentStore: ContentStore | null;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
  getCounters?: () => RuntimeCounters;
}

function deprecationLog(oldName: string, newName: string): void {
  console.error(`[compactor] DEPRECATED: Command "${oldName}" used — use "${newName}" instead.`);
}

export function registerCommands(pi: ExtensionAPI, deps?: CommandDeps): void {
  // ── /unipi:compact ──────────────────────────────────
  pi.registerCommand("unipi:compact", {
    description: "Trigger manual compaction with stats",
    handler: async (_args: string, ctx: any) => {
      const result = compactTool();
      const stats = getLastCompactionStats();
      const msg = stats
        ? `🗜️ Compaction: ${stats.summarized} summarized, ${stats.kept} kept (~${stats.keptTokensEst} tok)\n${result.message}`
        : `🗜️ ${result.message}`;
      ctx.ui.notify(msg, "info");
    },
  });

  // ── /unipi:session-recall (new) ─────────────────────
  const sessionRecallHandler = async (args: string, ctx: any) => {
    const query = args.trim();
    if (!query) {
      ctx.ui.notify("Usage: /unipi:session-recall <query>", "warning");
      return;
    }
    const blocks = deps?.getBlocks() ?? [];
    if (blocks.length === 0) {
      ctx.ui.notify("No session history available for search.", "warning");
      return;
    }
    const result = vccRecall(blocks, { query, limit: 10 });
    if (result.hits.length === 0) {
      ctx.ui.notify(`No results for "${query}".`, "info");
      return;
    }
    const lines = result.hits.map(
      (h, i) => `[${i + 1}] score=${h.score.toFixed(2)} kind=${h.kind}\n${h.text.slice(0, 200)}`,
    );
    ctx.ui.notify(`Found ${result.total} results:\n${lines.join("\n\n")}`, "info");
  };
  pi.registerCommand("unipi:session-recall", {
    description: "Search session history (BM25 or regex)",
    handler: sessionRecallHandler,
  });
  // Deprecated alias
  pi.registerCommand("unipi:compact-recall", {
    description: "(DEPRECATED) Search session history — use /unipi:session-recall instead",
    handler: async (args: string, ctx: any) => {
      deprecationLog("/unipi:compact-recall", "/unipi:session-recall");
      return sessionRecallHandler(args, ctx);
    },
  });

  // ── /unipi:compact-stats ─────────────────────────────
  pi.registerCommand("unipi:compact-stats", {
    description: "Show context savings dashboard",
    handler: async (_args: string, ctx: any) => {
      if (!deps?.sessionDB || !deps?.contentStore) {
        ctx.ui.notify("Compactor services not initialized.", "error");
        return;
      }
      try {
        const stats = await ctxStats(deps.sessionDB, deps.contentStore, deps.getSessionId(), deps.getCounters?.());
        const lines = [
          "📊 Compactor Stats",
          `Session events: ${stats.sessionEvents}`,
          `Compactions: ${stats.compactions}`,
          `Tokens saved: ${stats.tokensSaved}`,
          `Indexed docs: ${stats.indexedDocs} (${stats.indexedChunks} chunks)`,
          `Sandbox runs: ${stats.sandboxRuns}`,
          `Search queries: ${stats.searchQueries}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Stats error: ${err}`, "error");
      }
    },
  });

  // ── /unipi:compact-doctor ────────────────────────────
  pi.registerCommand("unipi:compact-doctor", {
    description: "Run diagnostics checklist",
    handler: async (_args: string, ctx: any) => {
      if (!deps?.sessionDB || !deps?.contentStore) {
        ctx.ui.notify("Compactor services not initialized.", "error");
        return;
      }
      try {
        const result = await ctxDoctor(deps.sessionDB, deps.contentStore);
        const icon = (s: string) => (s === "pass" ? "✅" : s === "warn" ? "⚠️" : "❌");
        const lines = [
          result.healthy ? "🩺 All checks passed" : "🩺 Issues found",
          "",
          ...result.checks.map((c) => `${icon(c.status)} ${c.name}: ${c.message}`),
        ];
        ctx.ui.notify(lines.join("\n"), result.healthy ? "info" : "warning");
      } catch (err) {
        ctx.ui.notify(`Doctor error: ${err}`, "error");
      }
    },
  });

  // ── /unipi:compact-settings ──────────────────────────
  pi.registerCommand("unipi:compact-settings", {
    description: "Open TUI settings overlay",
    handler: async (_args: string, ctx: any) => {
      try {
        const { renderSettingsOverlay } = await import("../tui/settings-overlay.js");
        const result = await ctx.ui.custom(renderSettingsOverlay());
        if (result) {
          ctx.ui.notify("Settings saved.", "info");
        } else {
          ctx.ui.notify("Settings cancelled.", "info");
        }
      } catch (err) {
        ctx.ui.notify(`Settings overlay error: ${err}`, "error");
      }
    },
  });

  // ── /unipi:compact-preset ────────────────────────────
  pi.registerCommand("unipi:compact-preset", {
    description: "Apply quick preset (precise/balanced/thorough/lean)",
    handler: async (args: string, ctx: any) => {
      const presetName = parsePreset(args.trim());
      if (!presetName) {
        ctx.ui.notify("Unknown preset. Use: precise, balanced, thorough, lean", "error");
        return;
      }
      const config = applyPreset(presetName);
      const result = saveConfig(config);
      if (result.success) {
        ctx.ui.notify(`Applied '${presetName}' preset.`, "info");
      } else {
        ctx.ui.notify(`Failed to save preset: ${result.error}`, "error");
      }
    },
  });

  // ── /unipi:content-index (new) / /unipi:compact-index (deprecated) ──
  const contentIndexHandler = async (_args: string, ctx: any) => {
    if (!deps?.contentStore) {
      ctx.ui.notify("Content store not initialized. Enable fts5Index in config.", "warning");
      return;
    }
    try {
      const cwd = (ctx as any).cwd ?? process.cwd();
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join, relative, extname } = await import("node:path");

      const indexable = [".md", ".txt", ".ts", ".js", ".json", ".py", ".sh"];
      const files: string[] = [];

      const walk = (dir: string, depth = 0) => {
        if (depth > 3) return;
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(full, depth + 1);
            } else if (indexable.includes(extname(entry.name))) {
              files.push(full);
            }
          }
        } catch {
          // skip unreadable dirs
        }
      };

      walk(cwd);
      let totalChunks = 0;
      for (const file of files.slice(0, 100)) {
        try {
          const content = readFileSync(file, "utf-8");
          if (content.length < 50) continue;
          const ext = extname(file);
          const ct = ext === ".md" ? "markdown" : ext === ".json" ? "json" : "plain";
          const result = await deps.contentStore!.index(relative(cwd, file), content, {
            contentType: ct,
            source: file,
          });
          totalChunks += result.totalChunks;
        } catch {
          // skip unreadable files
        }
      }
      ctx.ui.notify(`Indexed ${Math.min(files.length, 100)} files (${totalChunks} chunks).`, "info");
    } catch (err) {
      ctx.ui.notify(`Index error: ${err}`, "error");
    }
  };
  pi.registerCommand("unipi:content-index", {
    description: "Index current project files into FTS5",
    handler: contentIndexHandler,
  });
  pi.registerCommand("unipi:compact-index", {
    description: "(DEPRECATED) Index project files — use /unipi:content-index instead",
    handler: async (args: string, ctx: any) => {
      deprecationLog("/unipi:compact-index", "/unipi:content-index");
      return contentIndexHandler(args, ctx);
    },
  });

  // ── /unipi:content-search (new) / /unipi:compact-search (deprecated) ──
  const contentSearchHandler = async (args: string, ctx: any) => {
    const query = args.trim();
    if (!query) {
      ctx.ui.notify("Usage: /unipi:content-search <query>", "warning");
      return;
    }
    if (!deps?.contentStore) {
      ctx.ui.notify("Content store not initialized.", "warning");
      return;
    }
    try {
      const results = await ctxSearch(deps.contentStore!, { query, limit: 10 });
      if (results.length === 0) {
        ctx.ui.notify(`No results for "${query}".`, "info");
        return;
      }
      const lines = results.map(
        (r, i) => `[${i + 1}] ${r.title} (rank: ${r.rank.toFixed(3)})\n${r.content.slice(0, 200)}`,
      );
      ctx.ui.notify(`Found ${results.length} results:\n${lines.join("\n\n")}`, "info");
    } catch (err) {
      ctx.ui.notify(`Search error: ${err}`, "error");
    }
  };
  pi.registerCommand("unipi:content-search", {
    description: "Search indexed content",
    handler: contentSearchHandler,
  });
  pi.registerCommand("unipi:compact-search", {
    description: "(DEPRECATED) Search indexed content — use /unipi:content-search instead",
    handler: async (args: string, ctx: any) => {
      deprecationLog("/unipi:compact-search", "/unipi:content-search");
      return contentSearchHandler(args, ctx);
    },
  });

  // ── /unipi:content-purge (new) / /unipi:compact-purge (deprecated) ──
  const contentPurgeHandler = async (_args: string, ctx: any) => {
    if (!deps?.contentStore) {
      ctx.ui.notify("Content store not initialized.", "warning");
      return;
    }
    try {
      await deps.contentStore!.purge();
      ctx.ui.notify("All indexed content purged.", "info");
    } catch (err) {
      ctx.ui.notify(`Purge error: ${err}`, "error");
    }
  };
  pi.registerCommand("unipi:content-purge", {
    description: "Wipe all indexed content from FTS5",
    handler: contentPurgeHandler,
  });
  pi.registerCommand("unipi:compact-purge", {
    description: "(DEPRECATED) Wipe indexed content — use /unipi:content-purge instead",
    handler: async (args: string, ctx: any) => {
      deprecationLog("/unipi:compact-purge", "/unipi:content-purge");
      return contentPurgeHandler(args, ctx);
    },
  });

  // ── /unipi:compact-help ──────────────────────────────
  pi.registerCommand("unipi:compact-help", {
    description: "Show detailed compactor documentation (tier-2 skill)",
    handler: async (_args: string, ctx: any) => {
      // Load tier-2 skill content — delegates to skill loading system
      ctx.ui.notify(
        "🗜️ Compactor Help — Use your compactor-detail skill for full documentation.\n" +
        "Quick commands:\n" +
        "  /unipi:compact — trigger compaction\n" +
        "  /unipi:session-recall <query> — search session history\n" +
        "  /unipi:content-index — index project files\n" +
        "  /unipi:content-search <query> — search indexed content\n" +
        "  /unipi:content-purge — wipe indexed content\n" +
        "  /unipi:compact-stats — view stats\n" +
        "  /unipi:compact-doctor — run diagnostics\n" +
        "  /unipi:compact-settings — TUI settings\n" +
        "  /unipi:compact-preset <name> — apply preset",
        "info",
      );
    },
  });
}
