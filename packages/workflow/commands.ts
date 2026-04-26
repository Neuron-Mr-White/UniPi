/**
 * @unipi/workflow — Command registration and dispatch
 *
 * Each workflow command maps to a skill. The extension registers
 * slash commands that load and invoke the appropriate skill.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, WORKFLOW_COMMANDS, getToolsForCommand } from "@unipi/core";

/** Options for command registration */
export interface WorkflowCommandOptions {
  /** Check if ralph module is detected */
  isRalphDetected: () => boolean;
  /** Get current active tool names */
  getActiveTools: () => string[];
  /** Set active tools */
  setActiveTools: (tools: string[]) => void;
  /** Save tools for later restore */
  saveTools: (tools: string[]) => void;
}

/** Command definition */
interface WorkflowCommand {
  name: string;
  description: string;
  skillName: string;
  /** Extra context to inject when ralph is available */
  ralphHint?: string;
}

/** All workflow commands with their skill mappings */
const COMMANDS: WorkflowCommand[] = [
  {
    name: WORKFLOW_COMMANDS.BRAINSTORM,
    description:
      "Collaborative discovery — explore problem space, evaluate approaches, write design spec",
    skillName: "brainstorm",
  },
  {
    name: WORKFLOW_COMMANDS.PLAN,
    description:
      "Strategic planning — tasks, dependencies, acceptance criteria from specs",
    skillName: "plan",
  },
  {
    name: WORKFLOW_COMMANDS.WORK,
    description:
      "Execute plan — implement in worktree, test, commit on done",
    skillName: "work",
    ralphHint: "Ralph detected. Use /unipi:ralph-start for long-running tasks.",
  },
  {
    name: WORKFLOW_COMMANDS.REVIEW_WORK,
    description:
      "Review work — check task completion, run lint/build, mark reviewer remarks",
    skillName: "review-work",
  },
  {
    name: WORKFLOW_COMMANDS.CONSOLIDATE,
    description:
      "Consolidate — save learnings to memory, craft skills if reusable",
    skillName: "consolidate",
  },
  {
    name: WORKFLOW_COMMANDS.WORKTREE_CREATE,
    description: "Create git worktree for parallel work",
    skillName: "worktree-create",
  },
  {
    name: WORKFLOW_COMMANDS.WORKTREE_LIST,
    description: "List all unipi worktrees",
    skillName: "worktree-list",
  },
  {
    name: WORKFLOW_COMMANDS.WORKTREE_MERGE,
    description: "Merge worktrees back to main branch",
    skillName: "worktree-merge",
  },
  {
    name: WORKFLOW_COMMANDS.CONSULTANT,
    description:
      "Expert consultation — advisory with framework-based analysis",
    skillName: "consultant",
  },
  {
    name: WORKFLOW_COMMANDS.QUICK_WORK,
    description: "Fast single-task execution — one shot, summary recorded",
    skillName: "quick-work",
  },
  {
    name: WORKFLOW_COMMANDS.GATHER_CONTEXT,
    description:
      "Research codebase — surface patterns, find prior art, prepare for brainstorm",
    skillName: "gather-context",
  },
  {
    name: WORKFLOW_COMMANDS.DOCUMENT,
    description: "Generate documentation — README, API docs, guides",
    skillName: "document",
  },
  {
    name: WORKFLOW_COMMANDS.SCAN_ISSUES,
    description:
      "Deep investigation — find bugs, anti-patterns, security issues",
    skillName: "scan-issues",
  },
];

/**
 * Register all workflow commands with pi.
 */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  options: WorkflowCommandOptions,
): void {
  for (const cmd of COMMANDS) {
    const fullCommand = `${UNIPI_PREFIX}${cmd.name}`;

    pi.registerCommand(fullCommand, {
      description: cmd.description,
      handler: async (args, ctx) => {
        // Apply sandbox — save current tools, set command's tools
        const currentTools = options.getActiveTools();
        options.saveTools(currentTools);
        const sandboxTools = getToolsForCommand(cmd.name);
        options.setActiveTools([...sandboxTools]);

        // Build skill invocation message
        let message = `Execute the ${cmd.skillName} workflow.`;

        // Add args if provided
        if (args?.trim()) {
          message += `\n\nArguments: ${args.trim()}`;
        }

        // Add ralph hint if applicable
        if (cmd.ralphHint && options.isRalphDetected()) {
          message += `\n\n💡 ${cmd.ralphHint}`;
        }

        // Send as user message to trigger skill processing
        pi.sendUserMessage(message, { deliverAs: "followUp" });

        if (ctx.hasUI) {
          ctx.ui.notify(`Running /${fullCommand}`, "info");
        }
      },
    });
  }

  // Register the ralph integration command if ralph is detected
  pi.registerCommand(`${UNIPI_PREFIX}ralph-start`, {
    description: "Start a ralph loop for the current task",
    handler: async (args, ctx) => {
      if (!options.isRalphDetected()) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Ralph module not detected. Install @unipi/ralph first.",
            "warning",
          );
        }
        return;
      }

      // Delegate to ralph's start command
      const taskContent = args?.trim() || "Continue current task in a ralph loop.";
      pi.sendUserMessage(
        `Start a ralph loop with this task:\n\n${taskContent}`,
        { deliverAs: "followUp" },
      );

      if (ctx.hasUI) {
        ctx.ui.notify("Starting ralph loop...", "info");
      }
    },
  });
}

/**
 * Get list of all registered workflow command names.
 */
export function getWorkflowCommandNames(): string[] {
  return COMMANDS.map((c) => `${UNIPI_PREFIX}${c.name}`);
}
