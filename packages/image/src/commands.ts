/**
 * @pi-unipi/image — Slash commands
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IMAGE_COMMANDS, UNIPI_PREFIX } from "@pi-unipi/core";

import { showSettingsDialog } from "./tui/settings-dialog.js";

export function registerImageCommands(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}${IMAGE_COMMANDS.SETTINGS}`, {
    description: "Configure image generation and recognition models",
    handler: async (_args, ctx) => {
      await showSettingsDialog(ctx);
    },
  });
}
