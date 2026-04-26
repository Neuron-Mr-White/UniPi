/**
 * @unipi/workflow — Structured development workflow commands
 *
 * Registers 13 commands that dispatch to skills for LLM instruction.
 * Emits MODULE_READY event for inter-module discovery.
 * Detects @unipi/ralph presence for loop integration.
 * Applies sandbox (tool filtering) per command.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  WORKFLOW_COMMANDS,
  emitEvent,
  getPackageVersion,
  initUnipiDirs,
} from "@unipi/core";
import { registerWorkflowCommands } from "./commands.js";

/** Package version (read from package.json at load time) */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Whether ralph module is detected */
let ralphDetected = false;

/** Saved tools before sandbox was applied (for restore) */
let savedTools: string[] | null = null;

/** Whether sandbox is currently active */
let sandboxActive = false;

export default function (pi: ExtensionAPI) {
  // Register all workflow commands
  registerWorkflowCommands(pi, {
    isRalphDetected: () => ralphDetected,
    getActiveTools: () => pi.getActiveTools().map((t) => t.name),
    setActiveTools: (tools: string[]) => {
      pi.setActiveTools(tools);
      sandboxActive = true;
    },
    saveTools: (tools: string[]) => {
      savedTools = tools;
    },
  });

  // Restore tools when agent finishes
  pi.on("agent_end", async (_event, _ctx) => {
    if (sandboxActive && savedTools) {
      pi.setActiveTools(savedTools);
      savedTools = null;
      sandboxActive = false;
    }
  });

  // Announce module presence on session start
  pi.on("session_start", async (_event, ctx) => {
    // Initialize .unipi directory structure
    initUnipiDirs();

    // Emit MODULE_READY
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.WORKFLOW,
      version: VERSION,
      commands: Object.values(WORKFLOW_COMMANDS),
      tools: [],
    });

    // Listen for ralph module
    if (!ralphDetected) {
      try {
        // Check if ralph tools exist (indicates @unipi/ralph is loaded)
        const allTools = pi.getAllTools();
        ralphDetected = allTools.some((t) => t.name === "ralph_start");
      } catch {
        // Ignore — ralph not present
      }
    }

    // Show workflow status in UI
    if (ctx.hasUI) {
      const ralphStatus = ralphDetected ? "✓ ralph" : "○ ralph";
      ctx.ui.setStatus("unipi-workflow", `⚡ workflow ${ralphStatus}`);
    }
  });

  // Listen for ralph module ready event
  pi.on(UNIPI_EVENTS.MODULE_READY as any, (event: any) => {
    if (event?.name === MODULES.RALPH) {
      ralphDetected = true;
    }
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    ralphDetected = false;
    savedTools = null;
    sandboxActive = false;
  });
}
