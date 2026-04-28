/**
 * @pi-unipi/milestone — Extension entry point
 *
 * Lifecycle layer for project-level goals. Tracks progress via MILESTONES.md,
 * injects context on session start, auto-syncs on session end.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MODULES, emitEvent, UNIPI_EVENTS } from "@pi-unipi/core";

export default function milestoneExtension(pi: ExtensionAPI): void {
  // TODO: Register hooks, commands, info-screen group

  emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
    name: MODULES.MILESTONE,
    version: "0.1.0",
    commands: [],
    tools: [],
  });
}
