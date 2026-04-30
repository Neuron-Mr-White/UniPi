/**
 * @pi-unipi/footer — Commands
 *
 * Footer commands: /unipi:footer (toggle), /unipi:footer <preset>,
 * /unipi:footer-settings.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { PRESET_NAMES } from "./presets.js";
import { showFooterSettings } from "./tui/settings-tui.js";
import type { FooterGroup } from "./types.js";

/** Extension state interface */
interface FooterState {
  enabled: boolean;
  renderer: {
    setPreset(name: string): void;
    setActive(active: boolean): void;
    getPresetName(): string;
    resetLayoutCache(): void;
  };
  piContext: unknown;
}

/**
 * Register footer commands.
 */
export function registerCommands(
  pi: ExtensionAPI,
  state: FooterState,
  groups?: FooterGroup[],
): void {
  // /unipi:footer — toggle or switch preset
  pi.registerCommand("footer", {
    description: "Toggle footer or switch preset (default, minimal, compact, full, nerd, ascii)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        // Toggle on/off
        state.enabled = !state.enabled;
        state.renderer.setActive(state.enabled);

        if (state.enabled) {
          ctx.ui.notify("Footer enabled", "info");
        } else {
          ctx.ui.setFooter(undefined);
          ctx.ui.setWidget("footer-top", undefined);
          ctx.ui.setWidget("footer-secondary", undefined);
          ctx.ui.notify("Footer disabled", "info");
        }

        saveFooterSettings({ enabled: state.enabled });
        return;
      }

      const presetArg = args.trim().toLowerCase();
      if (PRESET_NAMES.includes(presetArg)) {
        state.renderer.setPreset(presetArg);
        saveFooterSettings({ preset: presetArg });
        ctx.ui.notify(`Footer preset: ${presetArg}`, "info");
        return;
      }

      ctx.ui.notify(`Available presets: ${PRESET_NAMES.join(", ")}`, "info");
    },
  });

  // /unipi:footer-settings — open settings TUI
  pi.registerCommand("footer-settings", {
    description: "Open footer settings (toggle groups and segments)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Footer settings requires a TUI", "warning");
        return;
      }

      if (groups && groups.length > 0) {
        showFooterSettings(ctx, groups);
      } else {
        // Fallback: show text summary
        const settings = loadFooterSettings();
        const info = [
          `Enabled: ${settings.enabled}`,
          `Preset: ${state.renderer.getPresetName()}`,
          `Separator: ${settings.separator}`,
          `Groups: ${Object.entries(settings.groups).filter(([, g]) => g.show).map(([id]) => id).join(", ")}`,
        ].join("\n");
        ctx.ui.notify(info, "info");
      }
    },
  });
}
