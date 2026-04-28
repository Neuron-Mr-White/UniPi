/**
 * @pi-unipi/milestone — Extension entry point
 *
 * Lifecycle layer for project-level goals. Tracks progress via MILESTONES.md,
 * injects context on session start, auto-syncs on session end.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODULES, MILESTONE_COMMANDS, MILESTONE_DIRS, emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";
import { registerSessionStartHook, registerSessionEndHook } from "./hooks.js";
import { registerCommands } from "./commands.js";
import { getProgressSummary } from "./milestone.js";
import * as path from "node:path";

export default function milestoneExtension(pi: ExtensionAPI): void {
  // Register lifecycle hooks
  registerSessionStartHook(pi);
  registerSessionEndHook(pi);

  // Register commands
  registerCommands(pi);

  // Register info-screen group
  const globalObj = globalThis as any;
  const registry = globalObj.__unipi_info_registry;
  if (registry) {
    registry.registerGroup({
      id: "milestone",
      name: "Milestones",
      icon: "🎯",
      priority: 40,
      config: {
        showByDefault: true,
        stats: [
          { id: "progress", label: "Progress", show: true },
          { id: "current_phase", label: "Current Phase", show: true },
          { id: "remaining", label: "Remaining", show: true },
        ],
      },
      dataProvider: async () => {
        const cwd = process.cwd();
        const milestonesPath = path.join(cwd, MILESTONE_DIRS.MILESTONES);
        const summary = getProgressSummary(milestonesPath);

        return {
          progress: {
            value: `${summary.completedItems}/${summary.totalItems}`,
            detail: `${summary.percentComplete}% complete`,
          },
          current_phase: {
            value: summary.currentPhase || "None",
            detail: summary.phases.length > 0
              ? summary.phases.map((p) => `${p.name}: ${p.done}/${p.total}`).join(", ")
              : "No milestones defined",
          },
          remaining: {
            value: String(summary.totalItems - summary.completedItems),
            detail: "items remaining",
          },
        };
      },
    });
  }

  // Emit module ready event
  emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
    name: MODULES.MILESTONE,
    version: "0.1.0",
    commands: Object.values(MILESTONE_COMMANDS),
    tools: [],
  });
}
