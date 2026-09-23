/**
 * All /unipi:compact-* commands
 *
 * Commands perform real work by calling tool implementations directly.
 * Dependencies (sessionDB, sessionId) are injected at registration time.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../config/manager.js";
import { applyPreset } from "../config/presets.js";
import { COMPACTOR_INSTRUCTION, formatTokens, registerCommandRunner } from "@pi-unipi/core";
import { getLastCompactionStats, formatCompactionStats } from "../compaction/hooks.js";
import { vccRecall } from "../tools/vcc-recall.js";
import { ctxStats } from "../tools/ctx-stats.js";
import { ctxDoctor } from "../tools/ctx-doctor.js";
import { recallBlocksFromContext } from "../session/recall-blocks.js";
import { filterNoise } from "../compaction/filter-noise.js";
import { parseRecallScope } from "../compaction/recall-scope.js";
import type { SessionDB } from "../session/db.js";
import type { NormalizedBlock, RuntimeCounters } from "../types.js";

export interface CommandDeps {
  sessionDB: SessionDB | null;
  getSessionId: () => string;
  getBlocks: () => NormalizedBlock[];
  getCounters?: () => RuntimeCounters;
}

export function registerCommands(pi: ExtensionAPI, deps?: CommandDeps): void {
  // ── /unipi:lossless-compact ──────────────────────────
  const losslessCompactHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    ctx.compact({
      customInstructions: COMPACTOR_INSTRUCTION,
      onComplete: () => {
        const stats = getLastCompactionStats();
        if (stats) {
          ctx.ui.notify(formatCompactionStats(stats), "info");
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
  };
  pi.registerCommand("unipi:lossless-compact", {
    description: "Immediate zero-LLM compaction — structured summary with full recall",
    handler: losslessCompactHandler,
  });
  pi.registerCommand("unipi:compact", {
    description: "Alias for /unipi:lossless-compact",
    handler: losslessCompactHandler,
  });

  // ── /unipi:session-recall (new) ─────────────────────
  // pi-vcc parity: results are sent as a visible custom message AND fed to the
  // agent as context (triggerTurn), so recall results drive the next turn.
  const sessionRecallHandler = async (args: string, ctx: ExtensionCommandContext, commandName = "/unipi:session-recall") => {
    const raw = args.trim();
    const suffix = commandName === "/unipi:compact-recall" ? " (deprecated; use /unipi:session-recall <query>)" : "";
    if (!raw) {
      ctx.ui.notify(`Usage: ${commandName} <query>${suffix}`, "warning");
      return;
    }

    // Parse scope:all and page:N inline (pi-vcc parity)
    const parsed = parseRecallScope(raw);
    const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
    const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
    const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();

    if (!query) {
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
    const result = vccRecall(blocks, { query, scope: parsed.scope, page });
    pi.sendMessage(
      { customType: "compactor-recall", content: result.text, display: true },
      { triggerTurn: true },
    );
  };
  pi.registerCommand("unipi:session-recall", {
    description: "Recall earlier parts of this session. Plain keywords work best; add scope:all to reach edited or retried turns.",
    handler: sessionRecallHandler,
  });
  // Deprecated alias
  pi.registerCommand("unipi:compact-recall", {
    description: "(DEPRECATED) Search session history — use /unipi:session-recall instead",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
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

  // Hub action runners — "Apply preset: X" rows in /unipi:settings. These
  // mirror the old /unipi:compact-preset <name> code path (applyPreset + save).
  for (const name of ["precise", "balanced", "thorough", "lean"] as const) {
    registerCommandRunner(`unipi:compact-apply-${name}`, () => {
      saveConfig(applyPreset(name));
    });
  }

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
        "  auto-compaction settings — /unipi:settings (Compactor group)\n" +
              "\n" +
        "Percentage trigger:\n" +
        "  Disabled by default. Enable it in /unipi:settings (Compactor › Auto) to compact at a context % before Pi's reserve-token limit.",
        "info",
      );
    },
  });
}
