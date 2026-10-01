/**
 * Compactor commands
 *
 *   /unipi:compact-vcc [keep:N]      lossless zero-LLM compaction
 *   /unipi:compact-by-llm [focus]    model-written summary (Pi's summarizer)
 *   /unipi:session-recall <query>    search the full session history
 *   /unipi:compact-stats | -doctor | -help
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { COMPACTOR_INSTRUCTION, formatTokens } from "@pi-unipi/core";
import { loadConfig } from "../config/manager.js";
import { setPendingCompaction } from "../compaction/hooks.js";
import { vccRecall } from "../tools/vcc-recall.js";
import { ctxDoctor } from "../tools/ctx-doctor.js";
import { recallBlocksFromContext } from "../session/recall-blocks.js";
import { filterNoise } from "../compaction/filter-noise.js";
import { parseRecallScope } from "../compaction/recall-scope.js";
import { methodBreakdown, sessionCompactionStats } from "../stats.js";
import type { CompactionMethod } from "../types.js";

function runCompaction(ctx: ExtensionCommandContext, method: CompactionMethod, args: string, command: string): void {
  const trimmed = args.trim();
  setPendingCompaction(method, true, command);
  ctx.compact({
    customInstructions: method === "llm" ? trimmed || undefined : trimmed ? `${COMPACTOR_INSTRUCTION} ${trimmed}` : COMPACTOR_INSTRUCTION,
    // Success shows as the compaction card in the transcript.
    onComplete: () => setPendingCompaction(null),
    onError: (err: Error) => {
      setPendingCompaction(null);
      // Pi already reports "Nothing to compact (session too small)".
      if (/too small/i.test(err.message)) return;
      if (err.message === "Compaction cancelled" || err.message === "Already compacted") ctx.ui.notify("Nothing to compact.", "info");
      else ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
    },
  });
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("unipi:compact-vcc", {
    description: "Lossless compaction now — instant structured summary, no model call (keep:N keeps N recent turns)",
    handler: async (args: string, ctx: ExtensionCommandContext) => runCompaction(ctx, "vcc", args, "unipi:compact-vcc"),
  });
  pi.registerCommand("unipi:compact-by-llm", {
    description: "Compact now with a model-written summary (optional text focuses the summary)",
    handler: async (args: string, ctx: ExtensionCommandContext) => runCompaction(ctx, "llm", args, "unipi:compact-by-llm"),
  });
  // pi-vcc parity: results are shown AND fed to the agent (triggerTurn).
  const sessionRecallHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const raw = args.trim();
    const usage = "Usage: /unipi:session-recall <query>";
    if (!raw) {
      ctx.ui.notify(usage, "warning");
      return;
    }
    const parsed = parseRecallScope(raw);
    const pageMatch = parsed.text.match(/\bpage:(\d+)\b/i);
    const page = pageMatch ? Math.max(1, parseInt(pageMatch[1], 10)) : 1;
    const query = parsed.text.replace(/\bpage:\d+\b/i, "").trim();
    if (!query) {
      ctx.ui.notify(usage, "warning");
      return;
    }
    const blocks = filterNoise(recallBlocksFromContext(ctx));
    if (blocks.length === 0) {
      ctx.ui.notify("No session history available for search.", "warning");
      return;
    }
    const result = vccRecall(blocks, { query, scope: parsed.scope, page });
    pi.sendMessage({ customType: "compactor-recall", content: result.text, display: true }, { triggerTurn: true });
  };
  pi.registerCommand("unipi:session-recall", {
    description: "Recall earlier parts of this session. Plain keywords work best; add scope:all to reach edited or retried turns.",
    handler: sessionRecallHandler,
  });
  pi.registerCommand("unipi:compact-stats", {
    description: "Show this session's compaction savings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const stats = sessionCompactionStats(ctx.sessionManager.getBranch() as any[]);
      const usage = ctx.getContextUsage?.();
      const lines = [
        "Compactor — this session",
        `Compactions: ${stats.compactions.length}${stats.compactions.length ? ` (${methodBreakdown(stats)})` : ""}`,
        `Tokens: ${stats.tokensBefore ? `${formatTokens(stats.tokensBefore)} → ${formatTokens(stats.tokensAfter)} (−${formatTokens(stats.tokensSaved)})` : "nothing compacted yet"}`,
        usage?.tokens != null && usage.contextWindow ? `Context now: ~${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}` : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("unipi:compact-doctor", {
    description: "Check compaction settings and leftovers",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const result = ctxDoctor(loadConfig(ctx.cwd), { hasModel: Boolean(ctx.model) });
      const icon = (s: string) => (s === "pass" ? "✓" : s === "warn" ? "!" : "✗");
      const lines = [
        result.healthy ? "Compactor: all checks passed" : "Compactor: issues found",
        ...result.checks.map((c) => `${icon(c.status)} ${c.name}: ${c.message}`),
      ];
      ctx.ui.notify(lines.join("\n"), result.healthy ? "info" : "warning");
    },
  });

  pi.registerCommand("unipi:compact-help", {
    description: "Show compactor help",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(
        [
          "Compactor",
          "  /unipi:compact-vcc [keep:N]    lossless compaction now (no model call)",
          "  /unipi:compact-by-llm [focus]  compact now with a model-written summary",
          "  /unipi:session-recall <query>  search everything in this session, including compacted parts",
          "  /unipi:compact-stats           this session's savings",
          "  /unipi:compact-doctor          check settings",
          "",
          "Settings: /unipi:settings → Compactor (method, what Pi's /compact does, when to compact).",
        ].join("\n"),
        "info",
      );
    },
  });
}
