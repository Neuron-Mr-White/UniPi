/**
 * @pi-unipi/utility — Extension entry
 *
 * Comprehensive utilities suite for Pi coding agent:
 * - Commands: continue, reload, status, cleanup, env, doctor
 * - Tools: ctx_batch, ctx_env
 * - Lifecycle: process management, stale cleanup
 * - Cache: TTL cache with optional persistence
 * - Analytics: lightweight event collection
 * - Diagnostics: cross-module health checks
 * - Display: terminal capabilities, width utilities
 * - TUI: settings inspector pattern
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
import { getLifecycle } from "./lifecycle/process.js";
import { getAnalyticsCollector } from "./analytics/collector.js";
import { registerInfoScreen } from "./info-screen.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** All commands registered by this module */
const ALL_COMMANDS = [
  UTILITY_COMMANDS.CONTINUE,
  UTILITY_COMMANDS.RELOAD,
  UTILITY_COMMANDS.STATUS,
  UTILITY_COMMANDS.CLEANUP,
  UTILITY_COMMANDS.ENV,
  UTILITY_COMMANDS.DOCTOR,
  UTILITY_COMMANDS.NAME_BADGE,
  UTILITY_COMMANDS.BADGE_GEN,
].map((cmd) => `unipi:${cmd}`);

/** All tools registered by this module */
const ALL_TOOLS = [UTILITY_TOOLS.BATCH, UTILITY_TOOLS.ENV];

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

  // Register commands
  registerUtilityCommands(pi);
  registerNameBadgeCommands(pi, nameBadgeState);

  // Register tools
  registerUtilityTools(pi);

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
  });

  // Listen for badge generation requests from other modules (e.g., kanboard)
  pi.on(UNIPI_EVENTS.BADGE_GENERATE_REQUEST as any, async (_event: any, ctx: any) => {
    // Show badge overlay if not already visible
    if (!nameBadgeState.isVisible() && ctx?.hasUI) {
      await nameBadgeState.show(pi, ctx);
    }
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
    await lifecycle.shutdown("session_shutdown");
  });
}

/**
 * Register utility tools.
 */
function registerUtilityTools(pi: ExtensionAPI): void {
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
}
