/**
 * @pi-unipi/footer — Commands
 *
 * Footer commands: /unipi:footer (toggle) and /unipi:footer <preset>.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_PREFIX, FOOTER_COMMANDS } from "@pi-unipi/core";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { showFooterHelp } from "./help.js";
import type { FooterSegment } from "./types.js";
import { applyGlanceMode, type FooterState } from "./index.js";

/**
 * Register footer commands.
 */
export function registerCommands(pi: ExtensionAPI, state: FooterState): void {
  // /unipi:footer — toggle on/off only
  pi.registerCommand(`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER}`, {
    description: "Toggle footer on/off",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();

      // on
      if (arg === "on") {
        state.enabled = true;
        state.renderer.setActive(true);
        saveFooterSettings({ enabled: true });
        state.setupUI?.(pi, ctx);
        ctx.ui.notify("Footer enabled", "info");
        return;
      }

      // off
      if (arg === "off") {
        state.enabled = false;
        state.renderer.setActive(false);
        ctx.ui.setFooter(undefined);
        ctx.ui.setWidget("footer-top", undefined);
        ctx.ui.setWidget("footer-secondary", undefined);
        saveFooterSettings({ enabled: false });
        ctx.ui.notify("Footer disabled", "info");
        return;
      }

      // Toggle (no args or unknown args)
      state.enabled = !state.enabled;
      state.renderer.setActive(state.enabled);

      if (state.enabled) {
        state.setupUI?.(pi, ctx);
        ctx.ui.notify("Footer enabled", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.setWidget("footer-top", undefined);
        ctx.ui.setWidget("footer-secondary", undefined);
        ctx.ui.notify("Footer disabled", "info");
      }

      saveFooterSettings({ enabled: state.enabled });
    },
  });

  // /unipi:footer-help — show help overlay
  pi.registerCommand(`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER_HELP}`, {
    description: "Show footer segment guide (icons, labels, descriptions)",
    handler: async (_args, _ctx) => {
      const allSegments = Array.from(state.segmentLookup.values());
      showFooterHelp(pi, allSegments, state.renderer.getPresetName());
    },
  });
}
