/**
 * @pi-unipi/milestone — Command registration
 *
 * Registers milestone-onboard and milestone-update commands with completions.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, MILESTONE_COMMANDS, MILESTONE_DIRS } from "@pi-unipi/core";
import { parseMilestones } from "./milestone.js";
import * as path from "node:path";

/**
 * Register milestone commands with the extension API.
 */
export function registerCommands(pi: ExtensionAPI): void {
  // milestone-onboard — create milestones from existing work
  pi.registerCommand(`${UNIPI_PREFIX}${MILESTONE_COMMANDS.ONBOARD}`, {
    description: "Create MILESTONES.md from existing workflow docs — scan, propose, refine, write",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(
        "🎯 Loading milestone-onboard skill... Use /unipi:milestone-onboard to start.",
        "info",
      );
    },
    getArgumentCompletions: () => {
      return [
        {
          value: "start",
          label: "start",
          description: "Begin milestone onboarding from existing docs",
        },
      ];
    },
  });

  // milestone-update — sync milestones with completed work
  pi.registerCommand(`${UNIPI_PREFIX}${MILESTONE_COMMANDS.UPDATE}`, {
    description: "Sync MILESTONES.md with completed work — scan docs, diff checkboxes, auto-update",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(
        "🔄 Loading milestone-update skill... Use /unipi:milestone-update to start.",
        "info",
      );
    },
    getArgumentCompletions: () => {
      // Suggest phase names from existing MILESTONES.md
      const cwd = process.cwd();
      const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);
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
