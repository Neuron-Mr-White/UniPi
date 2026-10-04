/**
 * @pi-unipi/footer — Commands
 *
 * /unipi:footer — toggle the footer on/off.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX, FOOTER_COMMANDS } from "@pi-unipi/core";
import { saveFooterSettings } from "./config.js";
import type { FooterState } from "./index.js";
import { fullRescan } from "./index.js";

/**
 * Register footer commands.
 */
export function registerCommands(pi: ExtensionAPI, state: FooterState): void {
  // /unipi:footer — toggle on/off only
  pi.registerCommand(`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER}`, {
    description: "Toggle footer on/off",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      let enable: boolean;
      if (arg === "on") enable = true;
      else if (arg === "off") enable = false;
      else enable = !state.enabled;

      state.enabled = enable;
      saveFooterSettings({ enabled: enable });

      if (enable) {
        state.setupUI?.(pi, ctx);
        fullRescan(state);
        ctx.ui.notify("Footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.setWidget("footer-top", undefined);
        ctx.ui.setWidget("footer-secondary", undefined);
        ctx.ui.notify("Footer disabled", "info");
      }
    },
  });
}
