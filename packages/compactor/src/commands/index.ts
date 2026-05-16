/**
 * All /unipi:compact-* commands
 *
 * Commands perform real work by calling tool implementations directly.
 * Dependencies (sessionDB, sessionId) are injected at registration time.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, saveConfig } from "../config/manager.js";
import { applyPreset, parsePreset } from "../config/presets.js";
import { COMPACTOR_INSTRUCTION } from "@pi-unipi/core";
import { getLastCompactionStats } from "../compaction/hooks.js";
import { vccRecall } from "../tools/vcc-recall.js";
import { ctxStats } from "../tools/ctx-stats.js";
import { ctxDoctor } from "../tools/ctx-doctor.js";
import { recallBlocksFromContext } from "../session/recall-blocks.js";
import { filterNoise } from "../compaction/filter-noise.js";
import type { SessionDB } from "../session/db.js";
import type { NormalizedBlock, RuntimeCounters } from "../types.js";

export interface CommandDeps {
  sessionDB: SessionDB | null;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
  getCounters?: () => RuntimeCounters;
}

function deprecationLog(_oldName: string, _newName: string): void {
  // Deprecation logging disabled — was writing to stdout causing TUI rendering issues.
}

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export function registerCommands(pi: ExtensionAPI, deps?: CommandDeps): void {
  // ── /unipi:lossless-compact ──────────────────────────
  pi.registerCommand("unipi:lossless-compact", {
    description: "Immediate zero-LLM compaction — structured summary with full recall",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.compact({
        customInstructions: COMPACTOR_INSTRUCTION,
        onComplete: () => {
          const stats = getLastCompactionStats();
          if (stats) {
            ctx.ui.notify(
              `Compacted ${stats.totalMessages} messages (~${formatTokens(stats.tokensBefore)} tokens) → ${stats.kept} messages (~${formatTokens(stats.tokensAfterEst)} tokens)`,
              "info",
            );
          } else {
            ctx.ui.notify("Compaction completed.", "info");
          }
        },
        onError: (err: Error) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact.", "info");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });
  // Deprecated alias — old name
  pi.registerCommand("unipi:compact", {
    description: "(DEPRECATED) Use /unipi:lossless-compact instead",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      deprecationLog("/unipi:compact", "/unipi:lossless-compact");
      ctx.compact({
        customInstructions: COMPACTOR_INSTRUCTION,
        onComplete: () => {
          const stats = getLastCompactionStats();
          if (stats) {
            ctx.ui.notify(
              `Compacted ${stats.totalMessages} messages (~${formatTokens(stats.tokensBefore)} tokens) → ${stats.kept} messages (~${formatTokens(stats.tokensAfterEst)} tokens)`,
              "info",
            );
          } else {
            ctx.ui.notify("Compaction completed.", "info");
          }
        },
        onError: (err: Error) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact.", "info");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });

  // ── /unipi:session-recall (new) ─────────────────────
  const sessionRecallHandler = async (args: string, ctx: ExtensionCommandContext, commandName = "/unipi:session-recall") => {
    const query = args.trim();
    if (!query) {
      const suffix = commandName === "/unipi:compact-recall" ? " (deprecated; use /unipi:session-recall <query>)" : "";
      ctx.ui.notify(`Usage: ${commandName} <query>${suffix}`, "warning");
      return;
    }

    // Prefer the live session branch over cached blocks. The branch includes raw
    // pre-compaction messages that are omitted from the compacted LLM context.
    const config = loadConfig((ctx as any).cwd ?? process.cwd());
    const liveBlocks = filterNoise(recallBlocksFromContext(ctx), config.pipeline?.customNoisePatterns);
    const blocks = liveBlocks.length > 0 ? liveBlocks : (deps?.getBlocks() ?? []);
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
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      deprecationLog("/unipi:compact-recall", "/unipi:session-recall");
      return sessionRecallHandler(args, ctx, "/unipi:compact-recall");
    },
  });

  // ── /unipi:compact-stats ─────────────────────────────
  pi.registerCommand("unipi:compact-stats", {
    description: "Show context savings dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!deps?.sessionDB) {
        ctx.ui.notify("Compactor services not initialized.", "error");
        return;
      }
      try {
        const stats = await ctxStats(deps.sessionDB, deps.getSessionId(), deps.getCounters?.());
        const lines = [
          "📊 Compactor Stats",
          `Session events: ${stats.sessionEvents}`,
          `Compactions: ${stats.compactions}`,
          `Tokens saved: ${stats.tokensSaved}`,
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
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!deps?.sessionDB) {
        ctx.ui.notify("Compactor services not initialized.", "error");
        return;
      }
      try {
        const result = await ctxDoctor(deps.sessionDB);
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
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const cwd = (ctx as any).cwd ?? process.cwd();
        const { renderSettingsOverlay } = await import("../tui/settings-overlay.js");
        const result = await ctx.ui.custom(renderSettingsOverlay(cwd));
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
    handler: async (args: string, ctx: ExtensionCommandContext) => {
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

  // ── /unipi:compact-help ──────────────────────────────
  pi.registerCommand("unipi:compact-help", {
    description: "Show detailed compactor documentation (tier-2 skill)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(
        "🗜️ Compactor Help\n" +
        "Quick commands:\n" +
        "  /unipi:lossless-compact — trigger immediate compaction\n" +
        "  /unipi:session-recall <query> — search session history\n" +
        "  /unipi:compact-stats — view stats\n" +
        "  /unipi:compact-doctor — run diagnostics\n" +
        "  /unipi:compact-settings — TUI settings\n" +
        "  /unipi:compact-preset <name> — apply preset\n" +
        "\n" +
        "Content indexing has moved to @pi-unipi/cocoindex:\n" +
        "  /unipi:cocoindex-init — initialize pipeline\n" +
        "  /unipi:cocoindex-update — index project files\n" +
        "  cocoindex_search — search indexed content",
        "info",
      );
    },
  });
}
