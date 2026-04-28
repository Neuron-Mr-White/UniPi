/**
 * @pi-unipi/milestone — Command registration
 *
 * Registers milestone-onboard and milestone-update commands.
 * Follows the same pattern as workflow/commands.ts:
 * loads SKILL.md content and sends it as a user message.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, MILESTONE_COMMANDS, MILESTONE_DIRS } from "@pi-unipi/core";
import { parseMilestones } from "./milestone.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolve the skills directory relative to this file */
const SKILLS_DIR = join(new URL(".", import.meta.url).pathname, "skills");

/**
 * Load SKILL.md content for a given skill name.
 */
function loadSkill(skillName: string): string {
  try {
    return readFileSync(join(SKILLS_DIR, skillName, "SKILL.md"), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Register milestone commands with the extension API.
 */
export function registerCommands(pi: ExtensionAPI): void {
  // milestone-onboard — create milestones from existing work
  pi.registerCommand(`${UNIPI_PREFIX}${MILESTONE_COMMANDS.ONBOARD}`, {
    description: "Create MILESTONES.md from existing workflow docs — scan, propose, refine, write",
    handler: async (args: string, ctx: any) => {
      const skillContent = loadSkill("milestone-onboard");

      let message = "Execute the milestone-onboard workflow.";
      if (args?.trim()) {
        message += `\n\nArguments: ${args.trim()}`;
      }
      if (skillContent) {
        message += `\n\n<skill_content>\n${skillContent}\n</skill_content>`;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });

      if (ctx.hasUI) {
        ctx.ui.notify("Running /unipi:milestone-onboard", "info");
      }
    },
  });

  // milestone-update — sync milestones with completed work
  pi.registerCommand(`${UNIPI_PREFIX}${MILESTONE_COMMANDS.UPDATE}`, {
    description: "Sync MILESTONES.md with completed work — scan docs, diff checkboxes, auto-update",
    handler: async (args: string, ctx: any) => {
      const skillContent = loadSkill("milestone-update");

      let message = "Execute the milestone-update workflow.";
      if (args?.trim()) {
        message += `\n\nArguments: ${args.trim()}`;
      }
      if (skillContent) {
        message += `\n\n<skill_content>\n${skillContent}\n</skill_content>`;
      }

      pi.sendUserMessage(message, { deliverAs: "followUp" });

      if (ctx.hasUI) {
        ctx.ui.notify("Running /unipi:milestone-update", "info");
      }
    },
    getArgumentCompletions: () => {
      // Suggest phase names from existing MILESTONES.md
      const cwd = process.cwd();
      const milestonesPath = join(cwd, MILESTONE_DIRS.MILESTONES);
      const doc = parseMilestones(milestonesPath);

      const suggestions = doc.phases.map((phase) => ({
        value: phase.name,
        label: phase.name,
        description: `${phase.items.filter((i) => i.checked).length}/${phase.items.length} done`,
      }));

      // Add "all" option
      suggestions.unshift({
        value: "all",
        label: "all",
        description: "Update all phases",
      });

      return suggestions;
    },
  });
}
