/**
 * All /unipi:compact-* commands
 *
 * Commands perform real work by calling tool implementations directly.
 * Dependencies (sessionDB, contentStore, sessionId) are injected at registration time.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig } from "../config/manager.js";
import { applyPreset, parsePreset } from "../config/presets.js";
import { getLastCompactionStats } from "../compaction/hooks.js";
import { compactTool } from "../tools/compact.js";
import { vccRecall } from "../tools/vcc-recall.js";
import { ctxStats } from "../tools/ctx-stats.js";
import { ctxDoctor } from "../tools/ctx-doctor.js";
import { ctxIndex } from "../tools/ctx-index.js";
import { ctxSearch } from "../tools/ctx-search.js";
import { ContentStore } from "../store/index.js";
import type { SessionDB } from "../session/db.js";
import type { NormalizedBlock } from "../types.js";

export interface CommandDeps {
  sessionDB: SessionDB | null;
  contentStore: ContentStore | null;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
}

export function registerCommands(pi: ExtensionAPI, deps?: CommandDeps): void {
  pi.registerCommand("unipi:compact", {
    description: "Trigger manual compaction with stats",
    handler: async (_args: string, ctx: any) => {
      const result = compactTool();
      const stats = getLastCompactionStats();
      const formatTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

      let allTimeMsg = "";
      if (deps?.sessionDB) {
        const allTime = deps.sessionDB.getAllTimeStats();
        const tokensCompacted = Math.round((allTime.allCharsBefore - allTime.allCharsKept) / 4);
        allTimeMsg = `\n📈 All-time: ${formatTok(tokensCompacted)} tokens compacted across ${allTime.allCompactions} compactions (${allTime.allMessagesSummarized} messages)`;
      }

      const msg = stats
        ? `🗜️ Compaction: ${stats.summarized} summarized, ${stats.kept} kept (~${formatTok(stats.keptTokensEst)} tok)${allTimeMsg}\n${result.message}`
        : `🗜️ ${result.message}${allTimeMsg}`;
      ctx.ui.notify(msg, "info");
    },
  });

  pi.registerCommand("unipi:compact-recall", {
    description: "Search session history (BM25 or regex)",
    handler: async (args: string, ctx: any) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /unipi:compact-recall <query>", "warning");
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
    },
  });

  pi.registerCommand("unipi:compact-stats", {
    description: "Show context savings dashboard",
    handler: async (_args: string, ctx: any) => {
      if (!deps?.sessionDB || !deps?.contentStore) {
        ctx.ui.notify("Compactor services not initialized.", "error");
        return;
      }
      try {
        const stats = await ctxStats(deps.sessionDB, deps.contentStore, deps.getSessionId());
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

  pi.registerCommand("unipi:compact-preset", {
    description: "Apply quick preset (opencode/balanced/verbose/minimal)",
    handler: async (args: string, ctx: any) => {
      const presetName = parsePreset(args.trim());
      if (!presetName) {
        ctx.ui.notify("Unknown preset. Use: opencode, balanced, verbose, minimal", "error");
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

  pi.registerCommand("unipi:compact-index", {
    description: "Index current project files into FTS5",
    handler: async (_args: string, ctx: any) => {
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
            const result = await deps.contentStore.index(relative(cwd, file), content, {
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
    },
  });

  pi.registerCommand("unipi:compact-search", {
    description: "Search indexed content",
    handler: async (args: string, ctx: any) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /unipi:compact-search <query>", "warning");
        return;
      }
      if (!deps?.contentStore) {
        ctx.ui.notify("Content store not initialized.", "warning");
        return;
      }
      try {
        const result = await ctxSearch({ query, limit: 10 });
        if (result.blocked) {
          ctx.ui.notify(result.warning, "error");
          return;
        }
        if (result.results.length === 0) {
          ctx.ui.notify(`No results for "${query}".${result.warning ? ` ${result.warning}` : ""}`, "info");
          return;
        }
        const lines = result.results.map(
          (r, i) => `[${i + 1}] ${r.title} (rank: ${r.rank.toFixed(3)})\n${r.content.slice(0, 200)}`,
        );
        const warningSuffix = result.warning ? `\n\n${result.warning}` : "";
        ctx.ui.notify(`Found ${result.results.length} results:\n${lines.join("\n\n")}${warningSuffix}`, "info");
      } catch (err) {
        ctx.ui.notify(`Search error: ${err}`, "error");
      }
    },
  });

  pi.registerCommand("unipi:compact-purge", {
    description: "Wipe all indexed content from FTS5",
    handler: async (_args: string, ctx: any) => {
      if (!deps?.contentStore) {
        ctx.ui.notify("Content store not initialized.", "warning");
        return;
      }
      try {
        await deps.contentStore.purge();
        ctx.ui.notify("All indexed content purged.", "info");
      } catch (err) {
        ctx.ui.notify(`Purge error: ${err}`, "error");
      }
    },
  });
}
