/**
 * @pi-unipi/compactor — Extension entry point
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODULES, UNIPI_EVENTS, COMPACTOR_COMMANDS, COMPACTOR_TOOLS, emitEvent } from "@pi-unipi/core";
import { scaffoldConfig, loadConfig } from "./config/manager.js";
import { registerCompactionHooks } from "./compaction/hooks.js";
import { SessionDB, getWorktreeSuffix } from "./session/db.js";
import { extractEventsFromToolResult } from "./session/extract.js";
import { injectResumeSnapshot } from "./session/resume-inject.js";
import { ContentStore } from "./store/index.js";
import { PolyglotExecutor } from "./executor/executor.js";
import { registerCommands } from "./commands/index.js";
import { registerCompactorTools } from "./tools/register.js";
import { normalizeMessages } from "./compaction/normalize.js";
import { filterNoise } from "./compaction/filter-noise.js";
import type { NormalizedBlock, CompactorStrategyConfig, RuntimeCounters } from "./types.js";
import type { RuntimeStats } from "./session/analytics.js";

/** Debug logger — only logs when config.debug === true */
function createDebugLogger(getConfig: () => { debug: boolean }) {
  return (_event: string, _data?: Record<string, unknown>) => {
    // Debug logging disabled — was writing to stdout causing TUI rendering issues.
    return;
  };
}

/** Measure byte size of a tool_result event's response content. */
function measureResponseBytes(event: any): number {
  try {
    const content = event.content;
    if (typeof content === "string") return Buffer.byteLength(content, "utf-8");
    if (Array.isArray(content)) {
      return content.reduce((sum: number, block: any) => {
        if (typeof block?.text === "string") return sum + Buffer.byteLength(block.text, "utf-8");
        if (typeof block === "string") return sum + Buffer.byteLength(block, "utf-8");
        return sum;
      }, 0);
    }
    if (event.output && typeof event.output === "string") return Buffer.byteLength(event.output, "utf-8");
  } catch {
    // Non-blocking: byte measurement errors silently skipped
  }
  return 0;
}

/** Check if a tool is a sandbox tool (output stays in sandbox, not context). */
function isSandboxTool(name: string): boolean {
  return name === "bash" || name === "Bash";
}

/** Check if a tool is an index tool (content goes to FTS5, not context). Future-proofing. */
function isIndexTool(_name: string): boolean {
  return false;
}

export default function compactorExtension(pi: ExtensionAPI): void {
  let sessionDB: SessionDB | null = null;
  let contentStore: ContentStore | null = null;
  let executor: PolyglotExecutor | null = null;
  let config = loadConfig();
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

  const runtimeStats: RuntimeStats = {
    bytesReturned: {},
    bytesIndexed: 0,
    bytesSandboxed: 0,
    calls: {},
    sessionStart: Date.now(),
    cacheHits: 0,
    cacheBytesSaved: 0,
  };

  const debug = createDebugLogger(() => config);

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

    // Initialize ContentStore independently — its failure shouldn't
    // prevent SessionDB commands from working.
    if (config.fts5Index.enabled) {
      try {
        const cs = new ContentStore();
        await cs.init();
        contentStore = cs;
      } catch {
        // Silently ignore — ContentStore init failure is handled gracefully.
        contentStore = null;
      }
    }

    executor = new PolyglotExecutor();
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
    contentStore,
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

    debug("session_start", { sessionId: fullSessionId, projectDir });

    // Reset runtime stats for new session
    runtimeStats.bytesReturned = {};
    runtimeStats.bytesIndexed = 0;
    runtimeStats.bytesSandboxed = 0;
    runtimeStats.calls = {};
    runtimeStats.sessionStart = Date.now();
    runtimeStats.cacheHits = 0;
    runtimeStats.cacheBytesSaved = 0;

    sessionDB?.ensureSession(fullSessionId, projectDir);

    // Register all compactor tools with Pi (deps now have live sessionDB)
    if (sessionDB) {
      registerCompactorTools(pi, {
        sessionDB,
        contentStore,
        getSessionId: () => currentSessionId,
        getBlocks: () => cachedBlocks,
        getCounters,
      });
    }

    // Register commands with live deps
    registerCommands(pi, getCommandDeps());

    // Register info-screen group
    const infoRegistry = (globalThis as any).__unipi_info_registry;
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
            const data = await getInfoScreenData(sdb, sid(), runtimeStats);
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

    emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.COMPACTOR,
      version: "0.1.0",
      commands: Object.values(COMPACTOR_COMMANDS),
      tools: Object.values(COMPACTOR_TOOLS),
    });

    debug("MODULE_READY", { commands: Object.values(COMPACTOR_COMMANDS), tools: Object.values(COMPACTOR_TOOLS) });

    if (config.fts5Index.mode === "auto" && contentStore) {
      // TODO: index project files
    }

    ctx.ui.notify("🗜️  Compactor ready", "info");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const cwd = (ctx as any).cwd ?? process.cwd();
    config = loadConfig(cwd);
    currentSessionId = `${(ctx as any).sessionId ?? "default"}${getWorktreeSuffix()}`;
    debug("before_agent_start", { sessionId: currentSessionId, configDebug: config.debug });

    // Evaluate autoDetect conditions for strategies
    try {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const strategies: Array<{ key: string; config: CompactorStrategyConfig }> = [
        { key: "commits", config: config.commits },
        { key: "fts5Index", config: config.fts5Index },
      ];
      for (const { key, config: strat } of strategies) {
        if ((strat as any).autoDetect === "git") {
          const gitDir = join(cwd, ".git");
          if (!existsSync(gitDir)) {
            debug("autoDetect_disable", { strategy: key, reason: "no .git dir" });
            // Non-destructive: temporarily disable at runtime, don't modify config file
            strat.enabled = false;
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Re-cache normalized blocks for vcc_recall
    try {
      const messages = (ctx as any).messages ?? [];
      if (messages.length > 0) {
        const normalized = normalizeMessages(messages);
        cachedBlocks = filterNoise(normalized, config.pipeline?.customNoisePatterns);
      }
    } catch {
      // Non-fatal: recall will work on empty blocks
    }

    if (sessionDB) {
      const snapshot = await injectResumeSnapshot(sessionDB, currentSessionId);
      debug("resume_snapshot", { injected: !!snapshot });

      // Auto-injection on compact: inject behavioral state after compaction
      if (snapshot && sessionDB) {
        try {
          const { buildAutoInjection } = await import("./session/auto-inject.js");
          const events = sessionDB.getEvents(currentSessionId, { limit: 100 });
          const autoInjection = buildAutoInjection(events);
          if (autoInjection) {
            debug("auto_injection", { tokens: autoInjection.tokens, length: autoInjection.text.length });
            // Note: auto-injection is included in the resume snapshot context
            // The model receives it as part of the session state restoration
          }
        } catch (err) {
          debug("auto_injection_error", { error: String(err) });
        }
      }
    }
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    if (sessionDB) {
      // Use closure currentSessionId — Pi's session_before_compact event
      // does not include sessionId at the top level.
      const sessionId = currentSessionId;
      const events = sessionDB.getEvents(sessionId, { limit: 1000 });
      const stats = sessionDB.getSessionStats(sessionId);
      debug("session_before_compact", { sessionId, eventCount: events.length, compactCount: stats?.compact_count ?? 0 });
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

      // Use actual runtimeStats for byte measurement instead of heuristic
      const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce((s, b) => s + b, 0);
      const totalBytesProcessed = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed + totalBytesReturned;

      if (tokensBefore > 0) {
        // Use actual token count from Pi's compactionEntry
        const charsBefore = tokensBefore * 4;
        // Estimate kept chars: proportional to what remains after compaction
        const tokensAfter = (event as any).tokensAfter ?? Math.round(tokensBefore * 0.15);
        const charsKept = tokensAfter * 4;
        const messagesSummarized = Math.max(1, Math.round(tokensBefore / 500));
        counters.totalTokensCompacted += tokensBefore - tokensAfter;
        sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, messagesSummarized);
      } else {
        // Fallback: estimate from runtime byte stats when tokensBefore unavailable
        if (totalBytesProcessed > 0) {
          const charsBefore = totalBytesProcessed;
          const charsKept = totalBytesReturned;
          const messagesSummarized = Math.max(1, Math.round(totalBytesProcessed / 2000));
          const estTokensBefore = Math.round(totalBytesProcessed / 4);
          const estTokensAfter = Math.round(totalBytesReturned / 4);
          counters.totalTokensCompacted += Math.max(0, estTokensBefore - estTokensAfter);
          sessionDB.addCompactionStats(sessionId, charsBefore, charsKept, messagesSummarized);
        }
      }
      debug("session_compact", { sessionId, tokensBefore, totalBytesProcessed, hasCompactionEntry: !!compactionEntry });
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    debug("session_shutdown");
    // WAL checkpoint: TRUNCATE on shutdown to keep DB file size down
    contentStore?.checkpointWAL("TRUNCATE");
    if (sessionDB) {
      sessionDB.cleanupOldSessions(7);
    }
    executor?.cleanupBackgrounded();
    contentStore?.close();
    sessionDB?.close();
  });

  pi.on("input", async (event, _ctx) => {
    const toolName = (event as any).toolName ?? "";
    const args = (event as any).args ?? {};
    debug("input", { toolName, args: JSON.stringify(args).slice(0, 200) });

    // Existing network tool guard
    if (toolName === "bash" || toolName === "Bash") {
      const cmd = String(args.command ?? "");
      if (/\b(curl|wget|nc|netcat)\b/.test(cmd)) {
        return { cancel: true } as any;
      }
    }

    // Security scanner/evaluator wiring (fail-open pattern)
    try {
      const { evaluateCommand, evaluateFilePath, loadProjectPermissions } = await import("./security/evaluator.js");
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
            debug("security_deny", { toolName, cmd: cmd.slice(0, 100) });
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
            debug("security_shell_escapes", { toolName, language, findings });
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
            debug("security_deny_file", { toolName, filePath });
            // Non-fatal: log warning but allow through (fail-open)
          }
        }
      }
    } catch (err) {
      // Fail-open: security checks are advisory, never block on errors
      debug("security_check_error", { error: String(err) });
    }

    return undefined;
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!sessionDB) return;
    // Use closure currentSessionId — tool_result events use the same session
    const sessionId = currentSessionId;
    const toolNameRaw = (event as any).toolName ?? "";
    const isError = (event as any).isError ?? false;

    debug("tool_result", { toolName: toolNameRaw, isError, sessionId });

    // Extract and store session events
    const toolEvents = extractEventsFromToolResult({
      toolName: (event as any).toolName ?? "",
      toolInput: (event as any).input ?? {},
      toolResponse: (event as any).content ? JSON.stringify((event as any).content).slice(0, 1000) : undefined,
      isError: (event as any).isError ?? false,
    });

    for (const ev of toolEvents) {
      sessionDB.insertEvent(sessionId, ev, "PostToolUse");
      debug("event_stored", { category: ev.category, type: ev.type });
    }

    // Track byte consumption per tool for analytics
    try {
      const responseBytes = measureResponseBytes(event);
      if (responseBytes > 0) {
        const tName = (event as any).toolName ?? "unknown";
        runtimeStats.calls[tName] = (runtimeStats.calls[tName] || 0) + 1;
        runtimeStats.bytesReturned[tName] = (runtimeStats.bytesReturned[tName] || 0) + responseBytes;
        if (isSandboxTool(tName)) {
          runtimeStats.bytesSandboxed += responseBytes;
        }
        if (isIndexTool(tName)) {
          runtimeStats.bytesIndexed += responseBytes;
        }
      }
    } catch {
      // Non-blocking: byte tracking errors silently skipped
    }

    // Apply display overrides for built-in tools
    const toolName = (event as any).toolName ?? "";
    const td = config.toolDisplay;
    const toolConfig = {
      readOutputMode: td?.mode as any,
      searchOutputMode: td?.mode as any,
      bashOutputMode: td?.mode as any,
      previewLines: 20,
      bashCollapsedLines: 5,
      showTruncationHints: true,
    };
    try {
      const { applyToolDisplayOverride } = await import("./display/tool-overrides.js");
      const override = applyToolDisplayOverride(toolName, event as any, toolConfig);
      if (override !== undefined) {
        return override as any;
      }
    } catch {
      // Non-fatal: display override failed
    }

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
            debug("diff_width_clamped", { toolName });
            return { details: { ...details, diff: clamped } } as any;
          }
        }
      } catch (err) {
        debug("diff_width_clamp_error", { error: String(err) });
      }
    }
  });

  pi.on("message_update", async (event, _ctx) => {
    const msg = (event as any).message;
    if (msg?.thinking) {
      debug("message_update", { thinking: true, length: String(msg.thinking).length });
    }
  });

  pi.on("message_end", async (_event, _ctx) => {
    debug("message_end");
  });

  pi.on("context", async (event, _ctx) => {
    const { sanitizeThinkingArtifacts } = await import("./display/thinking-label.js");
    const ctxStr = (event as any).context;
    if (typeof ctxStr === "string") {
      const sanitized = sanitizeThinkingArtifacts(ctxStr);
      if (sanitized !== ctxStr) {
        debug("context", { sanitized: true, beforeLen: ctxStr.length, afterLen: sanitized.length });
      }
      (event as any).context = sanitized;
    }
  });
}
