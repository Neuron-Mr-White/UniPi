/**
 * @pi-unipi/subagents — Extension entry
 *
 * Tools: spawn_helper, get_helper_result
 * Features: renderCall/renderResult, message renderer, conversation viewer
 * ESC propagation: all children abort on parent ESC
 */

import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emitEvent, MODULES, UNIPI_EVENTS } from "@pi-unipi/core";
import { AgentManager } from "./agent-manager.js";
import { initConfig } from "./config.js";
import { type AgentActivity, type NotificationDetails, BUILTIN_TYPES } from "./types.js";
import { ConversationViewer } from "./conversation-viewer.js";
import { AgentWidget } from "./widget.js";

/** Get info registry from global */
function getInfoRegistry() {
  const g = globalThis as any;
  return g.__unipi_info_registry;
}

// ---- Formatting helpers (shared between renderers and inline text) ----

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Tool name → human-readable action. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

function formatTurns(turn: number, max?: number | null): string {
  return max != null ? `⟳${turn}≤${max}` : `⟳${turn}`;
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Build activity description from active tools. */
function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }
    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }
  if (responseText && responseText.trim().length > 0) {
    const line = responseText.split("\n").find((l) => l.trim())?.trim() ?? "";
    if (line.length > 60) return line.slice(0, 60) + "…";
    if (line.length > 0) return line;
  }
  return "thinking…";
}

/** Format tokens safely from session. */
function safeFormatTokens(session: any): string {
  if (!session) return "";
  try {
    const stats = session.getSessionStats();
    const total = stats.tokens?.total ?? 0;
    return formatTokens(total);
  } catch {
    return "";
  }
}

/** Get raw token count from session. */
function safeTokenCount(session: any): number {
  if (!session) return 0;
  try {
    return session.getSessionStats().tokens?.total ?? 0;
  } catch {
    return 0;
  }
}

/** Build result text */
function textResult(msg: string, details?: any) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Escape XML for structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Human-readable status label. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

export default function (pi: ExtensionAPI) {
  // Initialize config
  const config = initConfig(process.cwd());
  if (!config.enabled) return;

  // Compute paths at factory time
  const homeDir = homedir();
  const cwd = process.cwd();
  const globalAgentsDir = join(homeDir, ".unipi", "config", "agents");
  const workspaceAgentsDir = join(cwd, ".unipi", "config", "agents");

  // Activity tracking for widget
  const agentActivity = new Map<string, AgentActivity>();

  // Create manager with completion callback
  const manager = new AgentManager(
    (record) => {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();

      // Build notification details
      const details = buildNotificationDetails(record, agentActivity.get(record.id));

      // Badge generation: extract name from agent result and set directly.
      // Mark resultConsumed BEFORE the notification check so the main agent
      // never sees this subagent.
      if (record.description === "Generate session name" && record.result && record.status === "completed") {
        const name = record.result.split("\n")[0]?.trim().slice(0, 50) ?? "";
        if (name && !name.startsWith("Error") && !name.includes("error")) {
          try {
            pi.setSessionName(name);
          } catch { /* best effort */ }
        }
        record.resultConsumed = true;
      }

      // Send styled notification via message renderer
      const status = getStatusLabel(record.status, record.error);
      const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
      const resultPreview = record.result
        ? record.result.length > 500
          ? record.result.slice(0, 500) + "…"
          : record.result
        : "No output.";

      const notificationXml = [
        `<task-notification>`,
        `<task-id>${record.id}</task-id>`,
        `<status>${escapeXml(status)}</status>`,
        `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
        `<result>${escapeXml(resultPreview)}</result>`,
        `<usage><total_tokens>${details.totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
        `</task-notification>`,
      ].join("\n");

      if (!record.resultConsumed) {
        pi.sendMessage<NotificationDetails>(
          {
            customType: "subagent-notification",
            content: notificationXml,
            display: true,
            details,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      }

      pi.events.emit("subagents:completed", {
        id: record.id,
        type: record.type,
        description: record.description,
        status: record.status,
        result: record.result,
        error: record.error,
      });
    },
    config.maxConcurrent,
    (record) => {
      pi.events.emit("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
      });
    },
  );

  // Build notification details for the message renderer
  function buildNotificationDetails(record: any, activity?: AgentActivity): NotificationDetails {
    return {
      id: record.id,
      description: record.description,
      status: record.status,
      toolUses: record.toolUses,
      turnCount: activity?.turnCount ?? 0,
      maxTurns: activity?.maxTurns,
      totalTokens: safeTokenCount(record.session),
      durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
      error: record.error,
      resultPreview: record.result
        ? record.result.length > 200
          ? record.result.slice(0, 200) + "…"
          : record.result
        : "No output.",
    };
  }

  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError
          ? d.status
          : d.status === "steered"
            ? "completed (steered)"
            : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    },
  );

  // Create widget
  const widget = new AgentWidget(manager, agentActivity);

  // Register info group at factory time (not session_start)
  const registry = getInfoRegistry();
  if (registry) {
    registry.registerGroup({
      id: "subagents",
      name: "Subagents",
      icon: "🤖",
      priority: 80,
      config: {
        showByDefault: true,
        stats: [
          { id: "maxConcurrent", label: "Max Concurrent", show: true },
          { id: "activeCount", label: "Active Agents", show: true },
          { id: "enabled", label: "Enabled", show: true },
          { id: "types", label: "Available Types", show: true },
        ],
      },
      dataProvider: async () => {
        const types = config.types || {};
        const builtinTypes = ["explore", "work"];

        const customTypes: string[] = [];
        for (const dir of [globalAgentsDir, workspaceAgentsDir]) {
          try {
            if (existsSync(dir)) {
              for (const file of readdirSync(dir)) {
                if (file.endsWith(".md") && !customTypes.includes(file.replace(".md", ""))) {
                  customTypes.push(file.replace(".md", ""));
                }
              }
            }
          } catch { /* ignore */ }
        }

        const allTypes = [...new Set([...builtinTypes, ...Object.keys(types), ...customTypes])];
        const typeList = allTypes.map((t) => {
          const isEnabled = types[t]?.enabled !== false;
          const isBuiltin = builtinTypes.includes(t);
          const scope = customTypes.includes(t) ? "project" : "global";
          return `${t}(${scope})${isEnabled ? "" : " [disabled]"}`;
        }).join(", ");

        const activeAgents = manager.listAgents().filter((a) => a.status === "running").length;

        return {
          maxConcurrent: { value: String(manager.getMaxConcurrent()) },
          activeCount: { value: String(activeAgents) },
          enabled: { value: config.enabled ? "yes" : "no" },
          types: {
            value: allTypes.length > 0 ? allTypes[0] : "none",
            detail: allTypes.length > 1 ? typeList : undefined,
          },
        };
      },
    });
  }

  // Store session context for badge generation
  let sessionCtx: any = null;

  // Session start: emit MODULE_READY + capture context
  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.SUBAGENTS || "subagents",
      version: "0.2.0",
      commands: [],
      tools: ["spawn_helper", "get_helper_result"],
    });
  });

  // Listen for badge generation requests — spawn background agent
  pi.events.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST, async (event: any) => {
    if (!sessionCtx) return;

    const summary = event?.conversationSummary ?? "";
    const prompt = summary
      ? `Based on this conversation, generate a concise session title (MAX 5 WORDS). Reply with ONLY the title. No quotes, no explanation, no punctuation.\n\nConversation:\n${summary}`
      : `Generate a concise session title (MAX 5 WORDS) for this session. Reply with ONLY the title. No quotes, no explanation, no punctuation.`;

    // Try with configured model, fallback to inherit
    let modelInput: string | undefined = undefined;
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const configPath = path.resolve(process.cwd(), ".unipi/config/badge.json");
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (typeof parsed.generationModel === "string" && parsed.generationModel !== "inherit") {
          modelInput = parsed.generationModel;
        }
      }
    } catch { /* ignore — inherit parent model */ }
    let resolvedModel: any = undefined;

    // Check if model is available
    if (modelInput && sessionCtx.modelRegistry) {
      const { resolveModel } = await import("./model-resolver.js");
      const result = resolveModel(modelInput, sessionCtx.modelRegistry);
      if (typeof result !== "string") {
        resolvedModel = result;
      }
      // If result is a string (error), resolvedModel stays undefined → inherit parent
    }

    manager.spawn(pi, sessionCtx, "name-gen", prompt, {
      description: "Generate session name",
      model: resolvedModel,
      isBackground: true,
      isolated: true,
      maxTurns: 1,
    });
  });

  // ESC propagation: abort all agents on session shutdown
  pi.on("session_shutdown", async () => {
    manager.abortAll();
    manager.dispose();
  });

  // Wire UI context for widget + age finished agents on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui);
    widget.onTurnStart();
  });

  // Create activity tracker
  function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
    const state: AgentActivity = {
      activeTools: new Map(),
      toolUses: 0,
      turnCount: 1,
      maxTurns,
      tokens: "",
      responseText: "",
    };

    const callbacks = {
      onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
        if (activity.type === "start") {
          state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
        } else {
          for (const [key, name] of state.activeTools) {
            if (name === activity.toolName) {
              state.activeTools.delete(key);
              break;
            }
          }
          state.toolUses++;
        }
        state.tokens = safeFormatTokens(state.session);
        onStreamUpdate?.();
      },
      onTextDelta: (_delta: string, fullText: string) => {
        state.responseText = fullText;
        onStreamUpdate?.();
      },
      onTurnEnd: (turnCount: number) => {
        state.turnCount = turnCount;
        onStreamUpdate?.();
      },
      onSessionCreated: (session: any) => {
        state.session = session;
      },
    };

    return { state, callbacks };
  }

  // ---- Agent tool ----

  const builtinTypes = BUILTIN_TYPES.join(", ");

  pi.registerTool(
    defineTool({
      name: "spawn_helper",
      label: "Spawn Helper",
      description: `Launch a sub-agent for parallel work.

Available agent types: ${builtinTypes}
Custom types can be defined in:
- ~/.unipi/config/agents/<name>.md (global)
- <workspace>/.unipi/config/agents/<name>.md (project)

Guidelines:
- Use "explore" for parallel file reads
- Use "work" for parallel file writes (transparent locking)
- Use run_in_background for work you don't need immediately
- ESC kills all running agents immediately
- Agents inherit the parent model by default`,
      parameters: Type.Object({
        type: Type.String({
          description: `Agent type: ${builtinTypes}, or custom type from ~/.unipi/config/agents/*.md`,
        }),
        prompt: Type.String({
          description: "The task for the agent to perform.",
        }),
        description: Type.String({
          description: "A short (3-5 word) description of the task.",
        }),
        run_in_background: Type.Optional(
          Type.Boolean({
            description: "Run in background. Returns helper ID immediately.",
          }),
        ),
        max_turns: Type.Optional(
          Type.Number({
            description: "Max agentic turns before stopping.",
            minimum: 1,
          }),
        ),
        model: Type.Optional(
          Type.String({
            description: 'Model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to inherit parent model.',
          }),
        ),
        thinking: Type.Optional(
          Type.String({
            description: "Thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit parent.",
          }),
        ),
      }),

      // ---- Rich inline rendering ----

      renderCall(args, theme) {
        const displayName = args.type ? args.type : "Agent";
        const desc = args.description ?? "";
        return new Text(
          "▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""),
          0,
          0,
        );
      },

      renderResult(result, { expanded, isPartial }, theme) {
        const details = result.details as any;
        if (!details) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          return new Text(text, 0, 0);
        }

        // Stats helper
        const stats = (d: any) => {
          const parts: string[] = [];
          if (d.turnCount != null && d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
          if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
          if (d.tokens) parts.push(d.tokens);
          return parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        };

        // Running
        if (isPartial || details.status === "running") {
          const frame = SPINNER[details.spinnerFrame ?? 0];
          const s = stats(details);
          let line = theme.fg("accent", frame) + (s ? " " + s : "");
          line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
          return new Text(line, 0, 0);
        }

        // Background launched
        if (details.status === "background") {
          return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
        }

        // Completed
        if (details.status === "completed") {
          const duration = formatMs(details.durationMs);
          const s = stats(details);
          let line = theme.fg("success", "✓") + (s ? " " + s : "");
          line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

          if (expanded) {
            const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
            if (resultText) {
              const rlines = resultText.split("\n").slice(0, 50);
              for (const l of rlines) {
                line += "\n" + theme.fg("dim", `  ${l}`);
              }
            }
          } else {
            line += "\n" + theme.fg("dim", "  ⎿  Done");
          }
          return new Text(line, 0, 0);
        }

        // Error / Aborted / Stopped
        const isError = details.status === "error";
        const isStopped = details.status === "stopped";
        const s = stats(details);
        let line = (isStopped ? theme.fg("dim", "■") : theme.fg("error", "✗")) + (s ? " " + s : "");

        if (isError) {
          line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
        } else if (isStopped) {
          line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        } else {
          line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
        }
        return new Text(line, 0, 0);
      },

      // ---- Execute ----

      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        widget.setUICtx(ctx.ui);

        const type = params.type as string;
        const prompt = params.prompt as string;
        const description = params.description as string;
        const runInBackground = params.run_in_background as boolean | undefined;
        const maxTurns = params.max_turns as number | undefined;
        const modelInput = params.model as string | undefined;
        const thinkingLevel = params.thinking as any | undefined;

        if (runInBackground) {
          const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(maxTurns);

          // Wrap onSessionCreated to sync tokens
          const origOnSession = bgCallbacks.onSessionCreated;
          bgCallbacks.onSessionCreated = (session: any) => {
            origOnSession(session);
            bgState.tokens = safeFormatTokens(session);
            widget.update();
          };

          const id = manager.spawn(pi, ctx, type, prompt, {
            description,
            maxTurns,
            modelInput,
            modelRegistry: ctx.modelRegistry,
            thinkingLevel,
            isBackground: true,
            ...bgCallbacks,
          });

          agentActivity.set(id, bgState);
          widget.ensureTimer();
          widget.update();

          const record = manager.getRecord(id);
          const isQueued = record?.status === "queued";

          return textResult(
            `Agent ${isQueued ? "queued" : "started"} in background.\n` +
              `ID: ${id}\n` +
              `Type: ${type}\n` +
              `Description: ${description}\n` +
              (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
              `\nYou will be notified when this agent completes.\n` +
              `Use get_result to retrieve full results.`,
            { status: "background", agentId: id },
          );
        }

        // Foreground execution — stream progress via onUpdate
        let spinnerFrame = 0;
        const startedAt = Date.now();
        let fgId: string | undefined;

        const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(maxTurns);

        const streamUpdate = () => {
          onUpdate?.({
            content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
            details: {
              status: "running",
              toolUses: fgState.toolUses,
              tokens: fgState.tokens,
              turnCount: fgState.turnCount,
              maxTurns: fgState.maxTurns,
              durationMs: Date.now() - startedAt,
              activity: describeActivity(fgState.activeTools, fgState.responseText),
              spinnerFrame: spinnerFrame % SPINNER.length,
            },
          });
        };

        // Wire session to register in widget
        const origOnSession = fgCallbacks.onSessionCreated;
        fgCallbacks.onSessionCreated = (session: any) => {
          origOnSession(session);
          fgState.tokens = safeFormatTokens(session);
          for (const a of manager.listAgents()) {
            if (a.session === session) {
              fgId = a.id;
              agentActivity.set(a.id, fgState);
              widget.ensureTimer();
              break;
            }
          }
        };

        const spinnerInterval = setInterval(() => {
          spinnerFrame++;
          streamUpdate();
        }, 80);

        streamUpdate();

        const record = await manager.spawnAndWait(pi, ctx, type, prompt, {
          description,
          maxTurns,
          modelInput,
          modelRegistry: ctx.modelRegistry,
          thinkingLevel,
          ...fgCallbacks,
        });

        clearInterval(spinnerInterval);

        // Clean up foreground agent from widget
        if (fgId) {
          agentActivity.delete(fgId);
          widget.markFinished(fgId);
          widget.update();
        }

        const tokenText = safeFormatTokens(fgState.session);
        const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;

        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}`, {
            status: "error",
            toolUses: record.toolUses,
            tokens: tokenText,
            durationMs,
            error: record.error,
          });
        }

        return textResult(
          `Agent completed in ${(durationMs / 1000).toFixed(1)}s (${record.toolUses} tool uses${tokenText ? `, ${tokenText} tokens` : ""}).\n\n` +
            (record.result?.trim() || "No output."),
          {
            status: "completed",
            toolUses: record.toolUses,
            tokens: tokenText,
            durationMs,
            turnCount: fgState.turnCount,
            maxTurns: fgState.maxTurns,
          },
        );
      },
    }),
  );

  // ---- get_helper_result tool ----

  pi.registerTool(
    defineTool({
      name: "get_helper_result",
      label: "Get Helper Result",
      description: "Check status and retrieve results from a background agent. Use view: true to open a live conversation overlay.",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The helper ID to check.",
        }),
        wait: Type.Optional(
          Type.Boolean({
            description: "Wait for completion. Default: false.",
          }),
        ),
        view: Type.Optional(
          Type.Boolean({
            description: "Open a live conversation viewer overlay. Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const record = manager.getRecord(params.agent_id as string);
        if (!record) {
          return textResult(`Helper not found: "${params.agent_id}". It may have been cleaned up.`);
        }

        // Open conversation viewer overlay if requested
        if (params.view && record.session) {
          const activity = agentActivity.get(record.id);
          await ctx.ui.custom<undefined>(
            (tui, theme, _keybindings, done) => {
              return new ConversationViewer(
                tui,
                record.session!,
                {
                  type: record.type,
                  description: record.description,
                  status: record.status,
                  toolUses: record.toolUses,
                  startedAt: record.startedAt,
                  completedAt: record.completedAt,
                },
                activity,
                theme,
                done,
              );
            },
            {
              overlay: true,
              overlayOptions: { anchor: "center", width: "90%" },
            },
          );
        }

        if (params.wait && record.status === "running" && record.promise) {
          record.resultConsumed = true;
          await record.promise;
        }

        const duration = record.completedAt
          ? `${((record.completedAt - record.startedAt) / 1000).toFixed(1)}s`
          : "running";

        let output =
          `Agent: ${record.id}\n` +
          `Type: ${record.type} | Status: ${record.status} | Tool uses: ${record.toolUses} | Duration: ${duration}\n` +
          `Description: ${record.description}\n\n`;

        if (record.status === "running") {
          output += "Agent is still running. Use wait: true or check back later.";
        } else if (record.status === "error") {
          output += `Error: ${record.error}`;
        } else {
          output += record.result?.trim() || "No output.";
        }

        if (record.status !== "running" && record.status !== "queued") {
          record.resultConsumed = true;
        }

        return textResult(output);
      },
    }),
  );
}
