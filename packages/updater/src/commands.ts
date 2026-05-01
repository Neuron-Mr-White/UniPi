/**
 * @pi-unipi/updater — Command Registration
 *
 * Registers /unipi:readme [package], /unipi:changelog, /unipi:updater-settings
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, UPDATER_COMMANDS } from "@pi-unipi/core";
import { renderReadmeOverlay } from "./tui/readme-overlay.js";
import { renderChangelogOverlay } from "./tui/changelog-overlay.js";
import { renderSettingsOverlay } from "./tui/settings-overlay.js";

/** Common overlay options for all updater overlays */
const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    width: "80%",
    minWidth: 60,
    anchor: "center",
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
      handler: async (args: string, ctx: any) => {
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
      handler: async (_args: string, ctx: any) => {
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

  // /unipi:updater-settings — Open updater settings
  pi.registerCommand(
    `${UNIPI_PREFIX}${UPDATER_COMMANDS.UPDATER_SETTINGS}`,
    {
      description: "Configure updater — check interval and auto-update mode",
      handler: async (_args: string, ctx: any) => {
        try {
          const result = await ctx.ui.custom(
            renderSettingsOverlay(),
            OVERLAY_OPTIONS,
          );
          if (result?.saved) {
            ctx.ui.notify("Updater settings saved.", "info");
          }
        } catch (err) {
          ctx.ui.notify(`Settings overlay error: ${err}`, "error");
        }
      },
    },
  );
}
