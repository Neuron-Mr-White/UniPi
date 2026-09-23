/**
 * @pi-unipi/updater — Command Registration
 *
 * Registers /unipi:readme [package] and /unipi:changelog
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX, UPDATER_COMMANDS } from "@pi-unipi/core";
import { renderReadmeOverlay } from "./tui/readme-overlay.js";
import { renderChangelogOverlay } from "./tui/changelog-overlay.js";

/** Common overlay options for all updater overlays */
const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    width: "80%" as const,
    minWidth: 60,
    anchor: "center" as const,
    margin: 2,
  },
};

/** Register updater commands */
export function registerCommands(pi: ExtensionAPI): void {
  // /unipi:readme [package] — Open readme browser
  pi.registerCommand(
    `${UNIPI_PREFIX}${UPDATER_COMMANDS.README}`,
    {
      description: "Browse package README files",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const packageName = args.trim() || undefined;
        try {
          await ctx.ui.custom(
            renderReadmeOverlay({ openDirect: packageName }),
            OVERLAY_OPTIONS,
          );
        } catch (err) {
          ctx.ui.notify(`Readme overlay error: ${err}`, "error");
        }
      },
    },
  );

  // /unipi:changelog — Open changelog browser
  pi.registerCommand(
    `${UNIPI_PREFIX}${UPDATER_COMMANDS.CHANGELOG}`,
    {
      description: "Browse changelog (Keep a Changelog format)",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        try {
          await ctx.ui.custom(
            renderChangelogOverlay(),
            OVERLAY_OPTIONS,
          );
        } catch (err) {
          ctx.ui.notify(`Changelog overlay error: ${err}`, "error");
        }
      },
    },
  );

}
