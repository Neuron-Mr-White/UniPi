/**
 * @pi-unipi/footer — Commands
 *
 * Footer commands: /unipi:footer (toggle), /unipi:footer <preset>,
 * /unipi:footer-settings.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, FOOTER_COMMANDS } from "@pi-unipi/core";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { showFooterSettings } from "./tui/settings-tui.js";
import { showFooterHelp } from "./help.js";
import type { FooterGroup, FooterSegment } from "./types.js";

/** Extension state interface */
interface FooterState {
  enabled: boolean;
  renderer: {
    setPreset(name: string): void;
    setActive(active: boolean): void;
    getPresetName(): string;
    resetLayoutCache(): void;
  };
  segmentLookup: Map<string, FooterSegment>;
  piContext: unknown;
  setupUI: ((pi: ExtensionAPI, ctx: any) => void) | null;
}

/**
 * Register footer commands.
 */
export function registerCommands(
  pi: ExtensionAPI,
  state: FooterState,
  groups?: FooterGroup[],
): void {
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

  // /unipi:footer-settings — open settings TUI
  pi.registerCommand(`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER_SETTINGS}`, {
    description: "Open footer settings (toggle groups and segments)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Footer settings requires a TUI", "warning");
        return;
      }

      if (groups && groups.length > 0) {
        showFooterSettings(ctx, groups, () => {
          // Re-read settings and update renderer
          const updated = loadFooterSettings();
          state.renderer.setPreset(updated.preset);
          state.renderer.resetLayoutCache();
        });
      } else {
        // Fallback: show text summary
        const settings = loadFooterSettings();
        const info = [
          `Enabled: ${settings.enabled}`,
          `Preset: ${state.renderer.getPresetName()}`,
          `Separator: ${settings.separator}`,
          `Icon: ${settings.iconStyle}`,
          `Groups: ${Object.entries(settings.groups).filter(([, g]) => g.show).map(([id]) => id).join(", ")}`,
        ].join("\n");
        ctx.ui.notify(info, "info");
      }
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
