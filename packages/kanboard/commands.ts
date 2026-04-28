/**
 * @pi-unipi/kanboard — Command Registration
 *
 * Registers kanboard and kanboard-doctor commands.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, KANBOARD_COMMANDS } from "@pi-unipi/core";
import { startServer } from "./server/index.js";
import { renderKanboardOverlay } from "./tui/kanboard-overlay.js";

/** Register kanboard commands */
export function registerCommands(pi: ExtensionAPI): void {
  // kanboard — Start server and show URL
  pi.registerCommand(
    `${UNIPI_PREFIX}${KANBOARD_COMMANDS.KANBOARD}`,
    {
      description: "Start the kanboard visualization server",
      handler: async (_args: string, ctx: any) => {
        try {
          const { url } = await startServer();
          ctx.ui.notify(`Kanboard running at ${url}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Failed to start kanboard: ${err.message}`, "error");
        }
      },
    },
  );

  // kanboard-doctor — Load doctor skill
  pi.registerCommand(
    `${UNIPI_PREFIX}${KANBOARD_COMMANDS.KANBOARD_DOCTOR}`,
    {
      description: "Diagnose and fix kanboard parser issues",
      handler: async (_args: string, ctx: any) => {
        ctx.ui.notify("Loading kanboard-doctor skill...", "info");
        // The skill will be loaded by the skill system via resources_discover
      },
    },
  );
}
