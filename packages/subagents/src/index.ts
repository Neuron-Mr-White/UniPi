/**
 * @pi-unipi/subagents — Extension entry
 *
 * Tools: Agent, get_result
 * ESC propagation: all children abort on parent ESC
 */

import { defineTool, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Get info registry from global
function getInfoRegistry() {
  const g = globalThis as any;
  return g.__unipi_info_registry;
}
import { AgentManager } from "./agent-manager.js";
import { initConfig, saveGlobalConfig } from "./config.js";
import { type AgentActivity, type AgentRecord, BUILTIN_TYPES } from "./types.js";
import { AgentWidget } from "./widget.js";

/** Format tokens safely. */
function safeFormatTokens(session: any): string {
  if (!session) return "";
  try {
    const stats = session.getSessionStats();
    const total = stats.tokens?.total ?? 0;
    if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
    if (total >= 1_000) return `${(total / 1_000).toFixed(1)}k`;
    return `${total}`;
  } catch {
    return "";
  }
}

/** Build result text. */
function textResult(msg: string, details?: any) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

export default function (pi: ExtensionAPI) {
  // Initialize config
  const config = initConfig(process.cwd());
  if (!config.enabled) return;

  // Activity tracking for widget
  const agentActivity = new Map<string, AgentActivity>();

  // Create manager with completion callback
  const manager = new AgentManager(
    (record) => {
      // On complete: clean up activity, emit event
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();

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
      // On start: emit event
      pi.events.emit("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
      });
    },
  );

  // Create widget
  const widget = new AgentWidget(manager, agentActivity);

  // Session start: notify agent about config paths
  pi.on("session_start", async (_event, ctx) => {
    const homedir = require("os").homedir();
    const globalConfig = `${homedir}/.unipi/config/subagents.json`;
    const globalAgents = `${homedir}/.unipi/config/agents/`;
    const workspaceConfig = `${ctx.cwd}/.unipi/config/subagents.json`;
    const workspaceAgents = `${ctx.cwd}/.unipi/config/agents/`;

    // Register info group
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
          ],
        },
        dataProvider: async () => {
          return {
            maxConcurrent: { value: String(manager.getMaxConcurrent()) },
            activeCount: { value: "N/A" },
            enabled: { value: config.enabled ? "yes" : "no" },
          };
        },
      });
    }

    ctx.ui.notify(
      `UniPi Subagents config:\n` +
      `• Global: ${globalConfig}\n` +
      `• Global agents: ${globalAgents}\n` +
      `• Workspace: ${workspaceConfig}\n` +
      `• Workspace agents: ${workspaceAgents}`,
      "info",
    );
  });

  // ESC propagation: abort all agents on session shutdown
  pi.on("session_shutdown", async () => {
    manager.abortAll();
    manager.dispose();
  });

  // Wire UI context for widget
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui);
    widget.update();
  });

  // Create activity tracker
  function createActivityTracker(maxTurns?: number) {
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
        widget.update();
      },
      onTextDelta: (_delta: string, fullText: string) => {
        state.responseText = fullText;
        widget.update();
      },
      onTurnEnd: (turnCount: number) => {
        state.turnCount = turnCount;
        widget.update();
      },
      onSessionCreated: (session: any) => {
        state.session = session;
        state.tokens = safeFormatTokens(session);
        widget.update();
      },
    };

    return { state, callbacks };
  }

  // ---- Agent tool ----

  const builtinTypes = BUILTIN_TYPES.join(", ");

  pi.registerTool(
    defineTool({
      name: "Agent",
      label: "Agent",
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
            description: "Run in background. Returns agent ID immediately.",
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

      execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        widget.setUICtx(ctx.ui);

        const type = params.type as string;
        const prompt = params.prompt as string;
        const description = params.description as string;
        const runInBackground = params.run_in_background as boolean | undefined;
        const maxTurns = params.max_turns as number | undefined;
        const modelInput = params.model as string | undefined;
        const thinkingLevel = params.thinking as any | undefined;

        // Create activity tracker
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(maxTurns);

        if (runInBackground) {
          // Background execution
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

        // Foreground execution
        let spinnerFrame = 0;
        const startedAt = Date.now();
        let fgId: string | undefined;

        const streamUpdate = () => {
          onUpdate?.({
            content: [{ type: "text", text: `${bgState.toolUses} tool uses...` }],
            details: {
              status: "running",
              toolUses: bgState.toolUses,
              tokens: bgState.tokens,
              turnCount: bgState.turnCount,
              maxTurns: bgState.maxTurns,
              durationMs: Date.now() - startedAt,
              activity: bgState.responseText
                ? bgState.responseText.split("\n").pop()?.trim().slice(0, 60)
                : "thinking…",
              spinnerFrame: spinnerFrame % 10,
            },
          });
          widget.update();
        };

        const spinnerInterval = setInterval(() => {
          spinnerFrame++;
          streamUpdate();
        }, 80);

        widget.ensureTimer();
        streamUpdate();

        const record = await manager.spawnAndWait(pi, ctx, type, prompt, {
          description,
          maxTurns,
          modelInput,
          modelRegistry: ctx.modelRegistry,
          thinkingLevel,
          ...bgCallbacks,
        });

        clearInterval(spinnerInterval);

        if (fgId) {
          agentActivity.delete(fgId);
          widget.markFinished(fgId);
        }

        const tokenText = safeFormatTokens(bgState.session);
        const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;

        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}`);
        }

        return textResult(
          `Agent completed in ${(durationMs / 1000).toFixed(1)}s (${record.toolUses} tool uses${tokenText ? `, ${tokenText} tokens` : ""}).\n\n` +
            (record.result?.trim() || "No output."),
        );
      },
    }),
  );

  // ---- get_result tool ----

  pi.registerTool(
    defineTool({
      name: "get_result",
      label: "Get Agent Result",
      description: "Check status and retrieve results from a background agent.",
      parameters: Type.Object({
        agent_id: Type.String({
          description: "The agent ID to check.",
        }),
        wait: Type.Optional(
          Type.Boolean({
            description: "Wait for completion. Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const record = manager.getRecord(params.agent_id as string);
        if (!record) {
          return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
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
