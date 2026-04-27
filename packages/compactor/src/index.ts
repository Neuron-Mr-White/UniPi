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
import type { NormalizedBlock } from "./types.js";

export default function compactorExtension(pi: ExtensionAPI): void {
  let sessionDB: SessionDB | null = null;
  let contentStore: ContentStore | null = null;
  let executor: PolyglotExecutor | null = null;
  let config = loadConfig();
  let cachedBlocks: NormalizedBlock[] = [];
  let currentSessionId = "default";

  const init = async () => {
    scaffoldConfig();
    config = loadConfig();

    sessionDB = new SessionDB();
    await sessionDB.init();

    if (config.fts5Index.enabled) {
      contentStore = new ContentStore();
      await contentStore.init();
    }

    executor = new PolyglotExecutor();
  };

  registerCompactionHooks(pi);

  // Register commands with deps (they need sessionDB/contentStore)
  const getCommandDeps = () => ({
    sessionDB,
    contentStore,
    getSessionId: () => currentSessionId,
    getBlocks: () => cachedBlocks,
  });
  registerCommands(pi, getCommandDeps());

  pi.on("session_start", async (_event, ctx) => {
    await init();

    const sessionId = (ctx as any).sessionId ?? "default";
    const projectDir = (ctx as any).cwd ?? process.cwd();
    const suffix = getWorktreeSuffix();
    const fullSessionId = `${sessionId}${suffix}`;
    currentSessionId = fullSessionId;

    sessionDB?.ensureSession(fullSessionId, projectDir);

    // Register all compactor tools with Pi
    if (sessionDB) {
      registerCompactorTools(pi, {
        sessionDB,
        contentStore,
        getSessionId: () => currentSessionId,
        getBlocks: () => cachedBlocks,
      });
    }

    // Re-register commands with fresh deps now that sessionDB is ready
    registerCommands(pi, getCommandDeps());

    emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.COMPACTOR,
      version: "0.1.0",
      commands: Object.values(COMPACTOR_COMMANDS),
      tools: Object.values(COMPACTOR_TOOLS),
    });

    if (config.fts5Index.mode === "auto" && contentStore) {
      // TODO: index project files
    }

    ctx.ui.notify("🗜️  Compactor ready", "info");
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    config = loadConfig();
    currentSessionId = `${(ctx as any).sessionId ?? "default"}${getWorktreeSuffix()}`;

    // Re-cache normalized blocks for vcc_recall
    try {
      const messages = (ctx as any).messages ?? [];
      if (messages.length > 0) {
        const normalized = normalizeMessages(messages);
        cachedBlocks = filterNoise(normalized);
      }
    } catch {
      // Non-fatal: recall will work on empty blocks
    }

    if (sessionDB) {
      const snapshot = await injectResumeSnapshot(sessionDB, currentSessionId);
      if (snapshot) {
        // Snapshot injected as context
      }
    }
  });

  pi.on("session_before_compact", async (event, _ctx) => {
    if (sessionDB) {
      const sessionId = `${(event as any).sessionId ?? "default"}${getWorktreeSuffix()}`;
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
      const sessionId = `${(event as any).sessionId ?? "default"}${getWorktreeSuffix()}`;
      sessionDB.incrementCompactCount(sessionId);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
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
    if (toolName === "bash" || toolName === "Bash") {
      const cmd = String(args.command ?? "");
      if (/\b(curl|wget|nc|netcat)\b/.test(cmd)) {
        return { cancel: true } as any;
      }
    }
    return undefined;
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!sessionDB) return;
    const sessionId = `${(event as any).sessionId ?? "default"}${getWorktreeSuffix()}`;

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
  });

  pi.on("message_update", async (event, _ctx) => {
    if ((event as any).message?.thinking) {
      // Handled by display engine
    }
  });

  pi.on("message_end", async (_event, _ctx) => {
    // Thinking label persistence
  });

  pi.on("context", async (event, _ctx) => {
    const { sanitizeThinkingArtifacts } = await import("./display/thinking-label.js");
    const ctx = (event as any).context;
    if (typeof ctx === "string") {
      (event as any).context = sanitizeThinkingArtifacts(ctx);
    }
  });
}
