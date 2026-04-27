/**
 * @unipi/workflow — Command registration and dispatch
 *
 * Each workflow command maps to a skill. The extension registers
 * slash commands that load and invoke the appropriate skill.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { UNIPI_PREFIX, WORKFLOW_COMMANDS, getToolsForCommand, getSandboxLevel, type SandboxLevel } from "@pi-unipi/core";

/** Options for command registration */
export interface WorkflowCommandOptions {
  /** Check if ralph module is detected */
  isRalphDetected: () => boolean;
  /** Get current active tool names */
  getActiveTools: () => string[];
  /** Set active tools with sandbox level */
  setActiveTools: (tools: string[], level: SandboxLevel) => void;
  /** Save tools for later restore */
  saveTools: (tools: string[]) => void;
}

/** Command definition */
interface WorkflowCommand {
  name: string;
  description: string;
  skillName: string;
  /** Argument hint shown in autocomplete */
  argumentHint?: string;
  /** Extra context to inject when ralph is available */
  ralphHint?: string;
}

/**
 * Suggest spec files from .unipi/docs/specs/ for plan command.
 */
function suggestSpecFiles(prefix: string): { value: string; label: string; description: string }[] {
  const specsDir = join(process.cwd(), ".unipi", "docs", "specs");
  if (!existsSync(specsDir)) return [];

  try {
    const search = prefix?.trim().split(/\s+/).pop() ?? "";
    const files = readdirSync(specsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, time: statSync(join(specsDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    return files
      .filter((f) => !search || f.name.includes(search))
      .map((f) => ({
        value: `specs:${f.name}`,
        label: basename(f.name, ".md"),
        description: `Spec: ${f.name}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Suggest plan files from .unipi/docs/plans/ for work and review-work commands.
 */
function suggestPlanFiles(prefix: string): { value: string; label: string; description: string }[] {
  const plansDir = join(process.cwd(), ".unipi", "docs", "plans");
  if (!existsSync(plansDir)) return [];

  try {
    const search = prefix?.trim().split(/\s+/).pop() ?? "";
    const files = readdirSync(plansDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ name: f, time: statSync(join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    return files
      .filter((f) => !search || f.name.includes(search))
      .map((f) => ({
        value: `plan:${f.name}`,
        label: basename(f.name, ".md"),
        description: `Plan: ${f.name}`,
      }));
  } catch {
    return [];
  }
}

/**
 * Suggest existing worktree names for merge/list commands.
 * Recursively scans for actual git worktrees (directories containing .git files).
 */
function suggestWorktrees(): { value: string; label: string; description: string }[] {
  const worktreesDir = join(process.cwd(), ".unipi", "worktrees");
  if (!existsSync(worktreesDir)) return [];

  try {
    const results: { value: string; label: string; description: string }[] = [];

    /**
     * Recursively find worktree directories (those containing a .git file).
     * A worktree's .git file contains: gitdir: /path/to/.git/worktrees/<branch>
     */
    function findWorktrees(dir: string, relativePath: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

        if (entry.name === ".git" && entry.isFile()) {
          // This is a worktree — extract branch name from gitdir path
          try {
            const gitContent = readFileSync(fullPath, "utf-8").trim();
            const match = gitContent.match(/gitdir:\s+.+?\/([^/]+)$/);
            const branchName = match?.[1] ?? entry.name;
            results.push({
              value: branchName,
              label: branchName,
              description: `Worktree: ${relPath}`,
            });
          } catch {
            // Can't read .git file — skip
          }
        } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          // Recurse into subdirectories (but not into nested .git or node_modules)
          findWorktrees(fullPath, relPath);
        }
      }
    }

    findWorktrees(worktreesDir, "");
    return results;
  } catch {
    return [];
  }
}

/** All workflow commands with their skill mappings */
const COMMANDS: WorkflowCommand[] = [
  {
    name: WORKFLOW_COMMANDS.BRAINSTORM,
    description:
      "Collaborative discovery — explore problem space, evaluate approaches, write design spec",
    skillName: "brainstorm",
    argumentHint: "<topic>",
  },
  {
    name: WORKFLOW_COMMANDS.PLAN,
    description:
      "Strategic planning — tasks, dependencies, acceptance criteria from specs",
    skillName: "plan",
    argumentHint: "specs:<file> <description>",
  },
  {
    name: WORKFLOW_COMMANDS.WORK,
    description:
      "Execute plan — implement in worktree, test, commit on done",
    skillName: "work",
    argumentHint: "plan:<file> <description>",
    ralphHint: "Ralph detected. Use /unipi:ralph-start for long-running tasks.",
  },
  {
    name: WORKFLOW_COMMANDS.REVIEW_WORK,
    description:
      "Review work — check task completion, run lint/build, mark reviewer remarks",
    skillName: "review-work",
    argumentHint: "plan:<file> <scope>",
  },
  {
    name: WORKFLOW_COMMANDS.CONSOLIDATE,
    description:
      "Consolidate — save learnings to memory, craft skills if reusable",
    skillName: "consolidate",
    argumentHint: "<what to consolidate>",
  },
  {
    name: WORKFLOW_COMMANDS.WORKTREE_CREATE,
    description: "Create git worktree for parallel work",
    skillName: "worktree-create",
    argumentHint: "<branch-name>",
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
    argumentHint: "<worktree>",
  },
  {
    name: WORKFLOW_COMMANDS.CONSULTANT,
    description:
      "Expert consultation — advisory with framework-based analysis",
    skillName: "consultant",
    argumentHint: "<question>",
  },
  {
    name: WORKFLOW_COMMANDS.QUICK_WORK,
    description: "Fast single-task execution — one shot, summary recorded",
    skillName: "quick-work",
    argumentHint: "<task>",
  },
  {
    name: WORKFLOW_COMMANDS.GATHER_CONTEXT,
    description:
      "Research codebase — surface patterns, find prior art, prepare for brainstorm",
    skillName: "gather-context",
    argumentHint: "<topic>",
  },
  {
    name: WORKFLOW_COMMANDS.DOCUMENT,
    description: "Generate documentation — README, API docs, guides",
    skillName: "document",
    argumentHint: "<target>",
  },
  {
    name: WORKFLOW_COMMANDS.SCAN_ISSUES,
    description:
      "Deep investigation — find bugs, anti-patterns, security issues",
    skillName: "scan-issues",
    argumentHint: "<scope>",
  },
  {
    name: WORKFLOW_COMMANDS.AUTO,
    description:
      "Full pipeline — brainstorm → plan → work → review → merge",
    skillName: "auto",
    argumentHint: "<description> plan:<file> specs:<file>",
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
      getArgumentCompletions: (prefix: string) => {
        let items: { value: string; label: string; description: string }[] | null = null;

        // Plan command: suggest spec files
        if (cmd.name === WORKFLOW_COMMANDS.PLAN) {
          items = suggestSpecFiles(prefix);
        }

        // Work command: suggest plan files
        if (cmd.name === WORKFLOW_COMMANDS.WORK) {
          items = suggestPlanFiles(prefix);
        }

        // Review-work command: suggest plan files
        if (cmd.name === WORKFLOW_COMMANDS.REVIEW_WORK) {
          items = suggestPlanFiles(prefix);
        }

        // Worktree merge: suggest existing worktrees
        if (cmd.name === WORKFLOW_COMMANDS.WORKTREE_MERGE) {
          items = suggestWorktrees();
        }

        // Worktree create: suggest existing worktrees as reference
        if (cmd.name === WORKFLOW_COMMANDS.WORKTREE_CREATE) {
          items = suggestWorktrees();
        }

        // Auto command: suggest plan files
        if (cmd.name === WORKFLOW_COMMANDS.AUTO) {
          items = suggestPlanFiles(prefix);
        }

        // Defensive: filter out any items with non-string value
        if (items) {
          return items.filter((item) => typeof item.value === "string");
        }

        // Other commands: no dynamic completions (free-text args)
        return null;
      },
      handler: async (args, ctx) => {
        // Apply sandbox — save current tools, set command's tools
        const currentTools = options.getActiveTools();
        options.saveTools(currentTools);
        const sandboxTools = getToolsForCommand(cmd.name);
        const sandboxLevel = getSandboxLevel(cmd.name);
        options.setActiveTools([...sandboxTools], sandboxLevel);

        // Load skill content from SKILL.md
        let skillContent = "";
        try {
          const skillPath = join(
            new URL("./skills", import.meta.url).pathname,
            cmd.skillName,
            "SKILL.md",
          );
          skillContent = readFileSync(skillPath, "utf-8");
        } catch {
          // Skill file not found — continue without it
        }

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

        // Inject skill content as context
        if (skillContent) {
          message += `\n\n<skill_content>\n${skillContent}\n</skill_content>`;
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
