/**
 * @pi-unipi/utility — Extension entry
 *
 * Comprehensive utilities suite for Pi coding agent:
 * - Commands: continue, reload, status, cleanup, env, doctor, badge
 * - Tools: ctx_batch, ctx_env, set_session_name
 * - Lifecycle: process management, stale cleanup
 * - Cache: TTL cache with optional persistence
 * - Analytics: lightweight event collection
 * - Diagnostics: cross-module health checks
 * - Display: terminal capabilities, width utilities
 * - TUI: settings inspector pattern, name badge
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  UTILITY_COMMANDS,
  UTILITY_TOOLS,
  emitEvent,
  getPackageVersion,
  type UnipiBadgeGenerateRequestEvent,
} from "@pi-unipi/core";
import { registerUtilityCommands, registerNameBadgeCommands } from "./commands.js";
import { NameBadgeState } from "./tui/name-badge-state.js";
import { readBadgeSettings } from "./tui/badge-settings.js";
import { readDiffSettings } from "./diff/settings.js";
import { registerEnhancedWriteTool, registerEnhancedEditTool } from "./diff/wrapper.js";
import { getLifecycle } from "./lifecycle/process.js";
import { getAnalyticsCollector } from "./analytics/collector.js";
import { registerInfoScreen } from "./info-screen.js";

/** Re-export readBadgeSettings for cross-package use */
export { readBadgeSettings } from "./tui/badge-settings.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Whether we've seen the first user message (for auto badge generation) */
let firstMessageSeen = false;

/** Stored user text from first input, used to build conversation summary after agent responds */
let firstUserText = "";

/** Stored UI context from first input, used to show badge overlay after agent responds */
let firstInputCtx: any = null;

/** All commands registered by this module */
const ALL_COMMANDS = [
  UTILITY_COMMANDS.CONTINUE,
  UTILITY_COMMANDS.RELOAD,
  UTILITY_COMMANDS.STATUS,
  UTILITY_COMMANDS.CLEANUP,
  UTILITY_COMMANDS.ENV,
  UTILITY_COMMANDS.DOCTOR,
  UTILITY_COMMANDS.BADGE_NAME,
  UTILITY_COMMANDS.BADGE_GEN,
  UTILITY_COMMANDS.BADGE_TOGGLE,
  UTILITY_COMMANDS.BADGE_SETTINGS,
  UTILITY_COMMANDS.UTIL_SETTINGS,
].map((cmd) => `unipi:${cmd}`);

/** All tools registered by this module */
const ALL_TOOLS = [UTILITY_TOOLS.BATCH, UTILITY_TOOLS.ENV, UTILITY_TOOLS.SET_SESSION_NAME];

export default function (pi: ExtensionAPI) {
  // Initialize lifecycle manager
  const lifecycle = getLifecycle();

  // Initialize analytics collector
  const analytics = getAnalyticsCollector();

  // Register cleanup on shutdown
  lifecycle.registerCleanup(async () => {
    analytics.disable();
  });

  // Initialize name badge state
  const nameBadgeState = new NameBadgeState();

  // Capture session context for cross-event use (not needed if BADGE_GENERATE_REQUEST removed)

  // Register commands
  registerUtilityCommands(pi);
  registerNameBadgeCommands(pi, nameBadgeState);

  // Register tools
  registerUtilityTools(pi, nameBadgeState);

  // Register info-screen group
  registerInfoScreen(pi);

  // Session lifecycle — announce module + restore badge
  pi.on("session_start", async (_event, ctx) => {
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.UTILITY,
      version: VERSION,
      commands: ALL_COMMANDS,
      tools: ALL_TOOLS,
    });

    analytics.recordModuleLoad(MODULES.UTILITY, VERSION);

    // Restore name badge if it was visible in previous session
    await nameBadgeState.restore(pi, ctx);

    // Register diff-enhanced tools if enabled
    const diffSettings = readDiffSettings();
    if (diffSettings.enabled) {
      const cwd = process.cwd();
      registerEnhancedWriteTool(pi, cwd);
      registerEnhancedEditTool(pi, cwd);
    }

    // Write model cache for TUI components
    if ((ctx as any).modelRegistry) {
      const { writeModelCache } = await import("@pi-unipi/core");
      const registry = (ctx as any).modelRegistry;
      const models = (registry.getAvailable?.() ?? registry.getAll())
        .map((m: any) => ({ provider: m.provider, id: m.id, name: m.name }));
      writeModelCache(models);
    }
  });

  // First-message hook: capture user text for deferred badge generation
  pi.on("input", async (_event: any, ctx: any) => {
    // Only trigger on first user message
    if (firstMessageSeen) return;
    firstMessageSeen = true;

    // Check if auto generation is enabled
    const settings = readBadgeSettings();
    if (!settings.autoGen) return;

    // Skip if badge already has a name
    const sessionName = pi.getSessionName?.();
    if (sessionName) return;

    // Store first message text for later use in agent_end
    firstUserText = typeof _event?.content === "string"
      ? _event.content
      : Array.isArray(_event?.content)
        ? _event.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join(" ")
        : "";

    // Store ctx for badge overlay show after agent responds
    firstInputCtx = ctx;
  });

  // After agent completes first response, generate badge name with full conversation context
  pi.on("agent_end", async (event: any, _ctx: any) => {
    // Only act if we captured a first input and are waiting for badge generation
    if (!firstInputCtx) return;
    const ctx = firstInputCtx;
    firstInputCtx = null; // consume — only trigger once

    // Check if a name was already set (e.g. manually) in the meantime
    const sessionName = pi.getSessionName?.();
    if (sessionName) return;

    // Show badge overlay if UI available
    if (ctx?.hasUI && !nameBadgeState.isVisible()) {
      await nameBadgeState.show(pi, ctx);
    }

    // Build conversation summary from full message history (user + assistant)
    const messages: any[] = event?.messages ?? [];
    const summaryParts: string[] = [];

    // Include the user's first message
    if (firstUserText) {
      summaryParts.push(`User: ${firstUserText}`);
    }

    // Include assistant's response text
    const assistantMsgs = messages.filter((m: any) => m.role === "assistant");
    for (const msg of assistantMsgs) {
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join(" ");
        if (textParts) summaryParts.push(`Assistant: ${textParts}`);
      } else if (typeof msg.content === "string" && msg.content) {
        summaryParts.push(`Assistant: ${msg.content}`);
      }
    }

    // Truncate to reasonable size
    const conversationSummary = summaryParts.join("\n").slice(0, 800);

    // Emit event for subagents to spawn background agent
    emitEvent(pi, UNIPI_EVENTS.BADGE_GENERATE_REQUEST, {
      source: "input-hook",
      conversationSummary,
    });
  });

  // Track command usage
  pi.on("tool_call", async (event) => {
    if (event.toolName.startsWith("unipi:")) {
      analytics.recordCommand(event.toolName, MODULES.UTILITY, 0, true);
    }
  });

  // Session shutdown cleanup
  pi.on("session_shutdown", async () => {
    nameBadgeState.hide();
    firstMessageSeen = false;
    firstUserText = "";
    firstInputCtx = null;
    await lifecycle.shutdown("session_shutdown");
  });
}

/**
 * Register utility tools.
 */
function registerUtilityTools(pi: ExtensionAPI, nameBadgeState: NameBadgeState): void {
  // ctx_batch — atomic batch execution
  pi.registerTool({
    name: UTILITY_TOOLS.BATCH,
    label: "Batch Execute",
    description:
      "Execute a batch of commands atomically with rollback support. " +
      "Accepts an array of {type, name, args} objects. " +
      "Options: failFast (default true), commandTimeoutMs, totalTimeoutMs.",
    promptSnippet: "Run multiple commands as an atomic batch.",
    parameters: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["command", "tool", "search"] },
              name: { type: "string" },
              args: { type: "object" },
            },
            required: ["type", "name"],
          },
        },
        options: {
          type: "object",
          properties: {
            failFast: { type: "boolean" },
            commandTimeoutMs: { type: "number" },
            totalTimeoutMs: { type: "number" },
          },
        },
      },
      required: ["commands"],
    },
    async execute(_toolCallId, params) {
      const { commands, options } = params as unknown as {
        commands: Array<{ type: string; name: string; args?: Record<string, unknown> }>;
        options?: Record<string, unknown>;
      };

      // Tool implementation delegates to batch executor
      // The actual executor must be provided by the host
      return {
        content: [
          {
            type: "text",
            text:
              "ctx_batch requires a command executor from the host environment. " +
              `Received ${commands.length} commands. ` +
              "Use BatchBuilder or executeBatch() directly in code.",
          },
        ],
        details: { commands, options },
      };
    },
  });

  // ctx_env — environment info
  pi.registerTool({
    name: UTILITY_TOOLS.ENV,
    label: "Environment Info",
    description: "Show environment information: Node version, Pi version, OS, unipi modules, config paths.",
    promptSnippet: "Get environment details for debugging.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute() {
      const { getEnvironmentInfo, formatEnvironmentInfo } = await import("./tools/env.js");
      const info = getEnvironmentInfo();
      return {
        content: [{ type: "text", text: formatEnvironmentInfo(info) }],
        details: info,
      };
    },
  });

  // set_session_name — set the session name for badge display
  const badgeSettings = readBadgeSettings();
  if (badgeSettings.agentTool) {
    pi.registerTool({
      name: UTILITY_TOOLS.SET_SESSION_NAME,
      label: "Set Session Name",
      description:
        "Set the session name that appears in the badge overlay and session selector. " +
        "Use this to give the current session a descriptive title. " +
        "Name should be concise (max 5 words recommended).",
      promptSnippet: "Set a name/title for the current session.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The session name to set (max 5 words recommended).",
          },
        },
        required: ["name"],
      },
      async execute(_toolCallId, params) {
        const { name } = params as { name: string };
        if (!name || typeof name !== "string") {
          return {
            content: [{ type: "text", text: "Error: name parameter is required and must be a string." }],
            details: undefined,
          };
        }

        const trimmed = name.trim();
        if (trimmed.length === 0) {
          return {
            content: [{ type: "text", text: "Error: name cannot be empty." }],
            details: undefined,
          };
        }

        // Set the session name
        nameBadgeState.setSessionName(pi, trimmed);

        return {
          content: [{ type: "text", text: `Session name set to: "${trimmed}"` }],
          details: { name: trimmed },
        };
      },
    });
  }
}
