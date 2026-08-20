/**
 * @pi-unipi/compactor — Extension entry point
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODULES, UNIPI_EVENTS, COMPACTOR_COMMANDS, COMPACTOR_TOOLS, COMPACTOR_INSTRUCTION, emitEvent } from "@pi-unipi/core";
import { scaffoldConfig, loadConfig } from "./config/manager.js";
import { registerCompactionHooks } from "./compaction/hooks.js";
import {
  createAutoCompactionState,
  decideAutoCompaction,
  markAutoCompactionComplete,
  markAutoCompactionError,
  type AutoCompactionState,
} from "./compaction/auto-trigger.js";
import { SessionDB, getWorktreeSuffix } from "./session/db.js";
import { extractEventsFromToolResult } from "./session/extract.js";
import { buildResumeContextMessage, isSessionContinuityEnabled } from "./session/resume-inject.js";
import { PolyglotExecutor } from "./executor/executor.js";
import { registerCommands } from "./commands/index.js";
import { registerCompactorTools } from "./tools/register.js";
import { normalizeMessages } from "./compaction/normalize.js";
import { filterNoise } from "./compaction/filter-noise.js";
import { recallBlocksFromContext } from "./session/recall-blocks.js";
import type { NormalizedBlock, CompactorStrategyConfig, RuntimeCounters } from "./types.js";

const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/** Measure byte size of a tool_result event's response content. */

/** Check if a tool is a sandbox tool (output stays in sandbox, not context). */

export default function compactorExtension(pi: ExtensionAPI): void {
  let sessionDB: SessionDB | null = null;
  let executor: PolyglotExecutor | null = null;
  let config = loadConfig();
  let autoCompactionState: AutoCompactionState = createAutoCompactionState();
  let cachedBlocks: NormalizedBlock[] = [];
  let currentSessionId = "default";
  const counters: RuntimeCounters = {
    sandboxRuns: 0,
    searchQueries: 0,
    recallQueries: 0,
    compactions: 0,
    totalTokensCompacted: 0,
  };
  const getCounters = () => counters;

  const init = async () => {
    scaffoldConfig();
    config = loadConfig();

    // Initialize SessionDB — this is required for core functionality.
    // If it fails, log the error and continue. Commands that depend on
    // sessionDB will report "not initialized" gracefully.
    // IMPORTANT: Don't assign sessionDB until init succeeds — a partially-
    // constructed instance with empty stmts would slip past null-guards.
    try {
      const db = new SessionDB();
      await db.init();
      sessionDB = db;
    } catch {
      // Silently ignore — SessionDB init failure is handled gracefully.
      sessionDB = null;
    }

    executor = null;
  };

  // Register compaction hooks with lazy deps — sessionDB/sessionId may not be
  // available at registration time, but will be by the time events fire.
  registerCompactionHooks(pi, {
    getSessionDB: () => sessionDB,
    getSessionId: () => currentSessionId,
  });

  // Commands registered inside session_start after init() when deps are ready
  const getCommandDeps = () => ({
    sessionDB,
    getSessionId: () => currentSessionId,
    getBlocks: () => cachedBlocks,
    getCounters,
  });

  pi.on("session_start", async (_event, ctx) => {
    await init();

    const sessionId = (ctx as any).sessionId ?? "default";
    const projectDir = (ctx as any).cwd ?? process.cwd();
    const suffix = getWorktreeSuffix();
    const fullSessionId = `${sessionId}${suffix}`;
    currentSessionId = fullSessionId;

    // Seed runtime counters from DB so they reflect prior usage
    if (sessionDB) {
      try {
        const allTime = sessionDB.getAllTimeStats();
        counters.sandboxRuns = allTime.allSandboxRuns;
        counters.searchQueries = allTime.allSearchQueries;
      } catch {
        // Non-fatal: counter seeding from DB failed
      }
    }

    // Reset runtime stats for new session
    autoCompactionState = createAutoCompactionState();

    sessionDB?.ensureSession(fullSessionId, projectDir);

    // Register all compactor tools with Pi (deps now have live sessionDB)
    if (sessionDB) {
      const sandboxEnabled = config.sandboxExecution.enabled && config.sandboxExecution.mode !== "off";
      executor = sandboxEnabled
        ? new PolyglotExecutor({ hardCapBytes: config.sandboxExecution.outputLimit, projectRoot: projectDir })
        : null;
      registerCompactorTools(pi, {
        sessionDB,
        getSessionId: () => currentSessionId,
        getBlocks: () => cachedBlocks,
        getCounters,
        sandbox: executor ? {
          executor,
          allowedLanguages: config.sandboxExecution.allowedLanguages,
        } : undefined,
      });
    }

    // Register commands with live deps
    registerCommands(pi, getCommandDeps());

    // Register info-screen group
    const infoRegistry = globalThis.__unipi_info_registry;
    if (infoRegistry && sessionDB) {
      const sdb = sessionDB;
      const sid = () => currentSessionId;
      infoRegistry.registerGroup({
        id: "compactor",
        name: "Compactor",
        icon: "🗜️",
        priority: 12,
        config: {
          showByDefault: true,
          stats: [
            { id: "tokensSaved", label: "Tokens saved", show: true },
            { id: "costSaved", label: "Cost saved", show: true },
            { id: "pctReduction", label: "% Reduction", show: true },
            { id: "topTools", label: "Top tools", show: true },
            { id: "compactions", label: "Compactions", show: true },
            { id: "toolCalls", label: "Tool calls", show: true },
          ],
        },
        dataProvider: async () => {
          try {
            const { getInfoScreenData } = await import("./info-screen.js");
            const data = await getInfoScreenData(sdb, sid(), getCounters());
            return {
              tokensSaved: { value: data.tokensSaved.value, detail: data.tokensSaved.detail },
              costSaved: { value: data.costSaved.value, detail: data.costSaved.detail },
              pctReduction: { value: data.pctReduction.value, detail: data.pctReduction.detail },
              topTools: { value: data.topTools.value, detail: data.topTools.detail },
              compactions: { value: data.compactions.value, detail: data.compactions.detail },
              toolCalls: { value: data.toolCalls.value, detail: data.toolCalls.detail },
            };
          } catch {
            return {};
          }
        },
      });
    }

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.COMPACTOR,
      version: "0.1.0",
      commands: Object.values(COMPACTOR_COMMANDS),
      tools: Object.values(COMPACTOR_TOOLS),
    });

    ctx.ui.notify("🗜️  Compactor ready", "info");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const cwd = (ctx as any).cwd ?? process.cwd();
    config = loadConfig(cwd);
    currentSessionId = `${(ctx as any).sessionId ?? "default"}${getWorktreeSuffix()}`;

    // Evaluate autoDetect conditions for strategies
    try {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const strategies: Array<{ key: string; config: CompactorStrategyConfig }> = [
        { key: "commits", config: config.commits },
      ];
      for (const { key, config: strat } of strategies) {
        if ((strat as any).autoDetect === "git") {
          const gitDir = join(cwd, ".git");
          if (!existsSync(gitDir)) {
            // Non-destructive: temporarily disable at runtime, don't modify config file
            strat.enabled = false;
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Re-cache normalized blocks for session_recall/vcc_recall.
    // Command/event contexts do not expose ctx.messages; use the append-only
    // session branch so recall can find raw messages hidden by compaction.
    try {
      const sessionBlocks = recallBlocksFromContext(ctx);
      if (sessionBlocks.length > 0) {
        cachedBlocks = filterNoise(sessionBlocks, config.pipeline?.customNoisePatterns);
      } else {
        // Defensive fallback for older Pi contexts that happened to expose messages.
        const messages = (ctx as any).messages ?? [];
        if (messages.length > 0) {
          const normalized = normalizeMessages(messages);
          cachedBlocks = filterNoise(normalized, config.pipeline?.customNoisePatterns);
        }
      }
    } catch {
      // Non-fatal: recall will work on empty blocks
    }

    const continuityEnabled = isSessionContinuityEnabled(config);
    if (sessionDB && continuityEnabled) {
      const resumeContext = await buildResumeContextMessage(sessionDB, currentSessionId);
      return resumeContext;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const cwd = (ctx as any).cwd ?? process.cwd();
    config = loadConfig(cwd);

    const decision = decideAutoCompaction({
      config: config.autoCompaction,
      usage: ctx.getContextUsage?.(),
      state: autoCompactionState,
      nowMs: Date.now(),
    });
    autoCompactionState = decision.state;

    if (!decision.shouldTrigger) return;

    const notify = config.autoCompaction.notify;
    if (notify && decision.usage) {
      ctx.ui.notify(
        `Auto-compacting at ${decision.usage.percent.toFixed(1)}% context (~${formatTokenCount(decision.usage.tokens)} tokens; threshold ${decision.thresholdPercent}%).`,
        "info",
      );
    }

    try {
      ctx.compact({
        customInstructions: COMPACTOR_INSTRUCTION,
        onComplete: () => {
          autoCompactionState = markAutoCompactionComplete(autoCompactionState);
          if (notify) {
            ctx.ui.notify("Auto-compaction completed.", "info");
          }
        },
        onError: (err: Error) => {
          autoCompactionState = markAutoCompactionError(autoCompactionState, Date.now());
          const benign = err.message === "Compaction cancelled" || err.message === "Already compacted";
          if (notify && !benign) {
            ctx.ui.notify(`Auto-compaction failed: ${err.message}`, "warning");
          }
        },
      });
    } catch (err) {
      autoCompactionState = markAutoCompactionError(autoCompactionState, Date.now());
      if (notify) {
        ctx.ui.notify(`Auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      }
    }
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    const continuityEnabled = isSessionContinuityEnabled(config);
    if (sessionDB && continuityEnabled) {
      // Use closure currentSessionId — Pi's session_before_compact event
      // does not include sessionId at the top level.
      const sessionId = currentSessionId;
      const events = sessionDB.getEvents(sessionId, { limit: 1000 });
      const stats = sessionDB.getSessionStats(sessionId);
      const { buildResumeSnapshot } = await import("./session/snapshot.js");
      const snapshot = buildResumeSnapshot(events, {
        compactCount: stats?.compact_count ?? 1,
      });
      sessionDB.upsertResume(sessionId, snapshot, events.length);
    }
  });

  pi.on("session_compact", async (event, _ctx) => {
    if (sessionDB) {
      // Use closure currentSessionId — Pi's session_compact event does not
      // include sessionId at the top level (it's inside compactionEntry).
      const sessionId = currentSessionId;
      sessionDB.incrementCompactCount(sessionId);
      counters.compactions++;

      // Pi's session_compact event structure: { compactionEntry, fromExtension }
      // tokensBefore is inside compactionEntry, not at event root.
      const compactionEntry = (event as any).compactionEntry;
      const tokensBefore = compactionEntry?.tokensBefore ?? 0;

      let summarized = 0;
      let kept = 0;
      let tokensSaved = 0;

      if (tokensBefore > 0) {
        // Use actual token count from Pi's compactionEntry.
        // Compaction typically keeps ~10-15% of original context.
        const charsBefore = tokensBefore * 4;
        const tokensAfter = Math.round(tokensBefore * 0.12);
        kept = tokensAfter;
        tokensSaved = tokensBefore - tokensAfter;
        const charsKept = tokensAfter * 4;
        const messagesSummarized = Math.max(1, Math.round(tokensBefore / 500));
        summarized = messagesSummarized;
        counters.totalTokensCompacted += tokensSaved;
        sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, messagesSummarized);
      } else {
        // tokensBefore unavailable — use session event count as a rough heuristic.
        // This happens when Pi's compaction doesn't report tokensBefore.
        // We estimate from the number of events stored in this session.
        try {
          const eventCount = sessionDB.getEventCount(sessionId);
          if (eventCount > 0) {
            // Rough estimate: ~500 tokens per event on average
            const estTokensBefore = eventCount * 500;
            const estTokensAfter = Math.round(estTokensBefore * 0.12);
            const charsBefore = estTokensBefore * 4;
            const charsKept = estTokensAfter * 4;
            summarized = eventCount;
            kept = estTokensAfter;
            tokensSaved = estTokensBefore - estTokensAfter;
            counters.totalTokensCompacted += tokensSaved;
            sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, eventCount);
          }
        } catch {
          // Non-fatal: heuristic estimation failed
        }
      }
      const totalEstimated = tokensSaved + kept;
      emitEvent(pi, UNIPI_EVENTS.COMPACTOR_COMPACTED, {
        sessionId,
        summarized,
        kept,
        tokensSaved,
        compressionRatio: kept > 0 ? `${Math.round(totalEstimated / kept)}:1` : "0:1",
      });
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (sessionDB) {
      sessionDB.cleanupOldSessions(7);
    }
    executor?.cleanupBackgrounded();
    sessionDB?.close();
  });

  pi.on("input", async (event, _ctx) => {
    const toolName = (event as any).toolName ?? "";
    const args = (event as any).args ?? {};

    // Existing network tool guard
    if (toolName === "bash" || toolName === "Bash") {
      const cmd = String(args.command ?? "");
      if (/\b(curl|wget|nc|netcat)\b/.test(cmd)) {
        return { cancel: true } as any;
      }
    }

    // Security scanner/evaluator wiring (fail-open pattern)
    try {
      const { evaluateCommand, evaluateFilePath } = await import("./security/evaluator.js");
      const { hasShellEscapes, scanForShellEscapes } = await import("./security/scanner.js");
      const { readsOrCreatesPolicy } = await import("./security/policy.js");

      // Load deny patterns from .pi/settings.json (fail-open: empty list on error)
      const cwd = (event as any).cwd ?? process.cwd();
      const denyPolicy = readsOrCreatesPolicy(cwd);

      // 1. Evaluate bash commands against deny patterns
      if (toolName === "bash" || toolName === "Bash" || toolName === "Bash") {
        const cmd = String(args.command ?? "");
        if (cmd) {
          const decision = evaluateCommand(cmd, denyPolicy);
          if (decision === "deny") {
            return {
              content: [{ type: "text", text: `Command blocked by security policy: ${cmd.slice(0, 80)}` }],
              isError: true,
            } as any;
          }
        }
      }

      // 2. Scan sandbox non-shell code for shell escapes
      const sandboxToolNames = ["ctx_execute", "ctx_execute_file", "sandbox", "sandbox_file"];
      if (sandboxToolNames.includes(toolName)) {
        const language = String(args.language ?? "");
        const code = String(args.code ?? "");
        if (language && language !== "shell" && code) {
          if (hasShellEscapes(code, language)) {
            const findings = scanForShellEscapes(code, language);
            // Fail-open: log but don't block (the hooks system is enforcement)
          }
        }
      }

      // 3. Evaluate file paths in read/write/edit operations
      const fileOpTools = ["read", "edit", "write", "Read", "Edit", "Write"];
      if (fileOpTools.includes(toolName)) {
        const filePath = args.path ?? args.filePath ?? args.file_path ?? "";
        if (filePath) {
          const decision = evaluateFilePath(filePath, denyPolicy, cwd);
          if (decision === "deny") {
            // Non-fatal: log warning but allow through (fail-open)
          }
        }
      }
    } catch (err) {
      // Fail-open: security checks are advisory, never block on errors
    }

    return undefined;
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!sessionDB) return;
    // Use closure currentSessionId — tool_result events use the same session
    const sessionId = currentSessionId;
    const toolNameRaw = (event as any).toolName ?? "";
    const isError = (event as any).isError ?? false;

    // Extract and store session events
    const toolEvents = extractEventsFromToolResult({
      toolName: (event as any).toolName ?? "",
      toolInput: (event as any).input ?? {},
      toolResponse: (event as any).content ? JSON.stringify((event as any).content).slice(0, 1000) : undefined,
      isError: (event as any).isError ?? false,
    });

    for (const ev of toolEvents) {
      sessionDB.insertEvent(sessionId, ev, "PostToolUse");
    }

    const toolName = (event as any).toolName ?? "";

    // Width-safe diff truncation for edit/write tool results.
    // Pi's renderDiff() does not truncate lines to terminal width,
    // causing TUI crashes on narrow terminals. We truncate the
    // diff string in details.diff before it reaches the TUI.
    const diffToolNames = ["edit", "Edit", "write", "Write"];
    if (diffToolNames.includes(toolName)) {
      try {
        const details = (event as any).details as
          { diff?: string } | undefined;
        if (details?.diff) {
          const { clampDiffToWidth } = await import(
            "./display/diff-width-safety.js"
          );
          const clamped = clampDiffToWidth(details.diff);
          if (clamped !== details.diff) {
            return { details: { ...details, diff: clamped } } as any;
          }
        }
      } catch (err) {
      }
    }
  });

  pi.on("context", async (event, _ctx) => {
    const { sanitizeThinkingArtifacts } = await import("./display/thinking-label.js");
    const ctxStr = (event as any).context;
    if (typeof ctxStr === "string") {
      const sanitized = sanitizeThinkingArtifacts(ctxStr);
      if (sanitized !== ctxStr) {
      }
      (event as any).context = sanitized;
    }
  });
}
