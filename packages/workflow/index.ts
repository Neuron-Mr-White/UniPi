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
  type SandboxLevel,
  getToolsForLevel,
} from "@pi-unipi/core";
import { registerWorkflowCommands } from "./commands.js";

/** Package version (read from package.json at load time) */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Whether ralph module is detected */
let ralphDetected = false;

/** Saved tools before sandbox was applied (for restore) */
let savedTools: string[] | null = null;

/** Whether sandbox is currently active */
let sandboxActive = false;

/** Current sandbox level (null = no sandbox) */
let currentSandboxLevel: SandboxLevel | null = null;

export default function (pi: ExtensionAPI) {
  // Register skills directory with pi's resource loader
  const skillsDir = new URL("./skills", import.meta.url).pathname;
  pi.on("resources_discover", async (_event, _ctx) => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Register all workflow commands
  registerWorkflowCommands(pi, {
    isRalphDetected: () => ralphDetected,
    getActiveTools: () => pi.getActiveTools(),
    setActiveTools: (tools: string[], level: SandboxLevel) => {
      pi.setActiveTools(tools);
      sandboxActive = true;
      currentSandboxLevel = level;
    },
    saveTools: (tools: string[]) => {
      savedTools = tools;
    },
  });

  // Block tool calls that violate sandbox
  pi.on("tool_call", async (event, _ctx) => {
    if (!sandboxActive || !currentSandboxLevel) return;

    const allowed = getToolsForLevel(currentSandboxLevel);
    if (!allowed.includes(event.toolName)) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed in ${currentSandboxLevel} sandbox. Allowed: ${allowed.join(", ")}`,
      };
    }
  });

  // Inject sandbox constraints into system prompt so LLM knows its limits
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!sandboxActive || !currentSandboxLevel) return;

    const allowed = getToolsForLevel(currentSandboxLevel);
    const blocked = ["read", "write", "edit", "bash", "grep", "find", "ls"]
      .filter((t) => !allowed.includes(t));

    const base = `\n\n<sandbox>\nSandbox mode: ${currentSandboxLevel}.\nAvailable tools: ${allowed.join(", ")}.\nBlocked tools: ${blocked.join(", ")} — removed from your tool list.`;

    if (currentSandboxLevel === "brainstorm") {
      return {
        systemPrompt:
          event.systemPrompt +
          base +
          `\nThe write tool is available but restricted to .unipi/docs/specs/ only.\nbash is available ONLY for specific setup use case (e.g., git init, mkdir). Do NOT use bash for reading files or listing directories — use grep, find, ls instead.\nDo NOT attempt to call blocked tools. Do NOT output tool call XML for them.\nIf the user requests an action that requires a blocked tool, respond that you do not have access.\n</sandbox>`,
      };
    }

    if (currentSandboxLevel === "write_unipi") {
      return {
        systemPrompt:
          event.systemPrompt +
          base +
          `\nWrite tool is restricted to .unipi/docs/ only (specs and plans).\nUse grep, find, ls for file discovery — do NOT guess filenames.\nbash is blocked — use read, write, edit, grep, find, ls only.\nDo NOT attempt to call blocked tools. Do NOT output tool call XML for them.\nIf the user requests an action that requires a blocked tool, respond that you do not have access.\n</sandbox>`,
      };
    }

    return {
      systemPrompt:
        event.systemPrompt +
        base +
        `\nDo NOT attempt to call blocked tools. Do NOT output tool call XML for them.\nIf the user requires an action that requires a blocked tool, respond that you do not have access.\n</sandbox>`,
    };
  });

  // Restore tools when agent finishes
  pi.on("agent_end", async (_event, _ctx) => {
    if (sandboxActive && savedTools) {
      pi.setActiveTools(savedTools);
      savedTools = null;
      sandboxActive = false;
      currentSandboxLevel = null;
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
