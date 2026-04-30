/**
 * @pi-unipi/footer — Commands
 *
 * Footer commands: /unipi:footer (toggle), /unipi:footer <preset>,
 * /unipi:footer-settings.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, FOOTER_COMMANDS } from "@pi-unipi/core";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { PRESET_NAMES } from "./presets.js";
import { showFooterSettings } from "./tui/settings-tui.js";
import type { FooterGroup, SeparatorStyle, IconStyle } from "./types.js";
import { setIconStyle } from "./rendering/icons.js";

/** Minimal autocomplete item (compatible with pi-tui AutocompleteItem) */
interface ArgSuggestion {
  value: string;
  label: string;
  description?: string;
}

/** All valid separator styles */
const SEPARATOR_STYLES: SeparatorStyle[] = [
  "powerline",
  "powerline-thin",
  "slash",
  "pipe",
  "dot",
  "ascii",
];

/** All valid icon styles */
const ICON_STYLES: IconStyle[] = [
  "nerd",
  "emoji",
  "text",
];

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
  pi.registerCommand(`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER}`, {
    description: "Toggle footer or switch preset (default, minimal, compact, full, nerd, ascii)",
    getArgumentCompletions(argumentPrefix: string): ArgSuggestion[] | null {
      const allOptions: ArgSuggestion[] = [
        ...PRESET_NAMES.map(p => ({
          value: p,
          label: p,
          description: `Switch to ${p} preset`,
        })),
        ...SEPARATOR_STYLES.map(s => ({
          value: `sep:${s}`,
          label: `sep:${s}`,
          description: `Set separator style: ${s}`,
        })),
        ...ICON_STYLES.map(s => ({
          value: `icon:${s}`,
          label: `icon:${s}`,
          description: `Set icon style: ${s}`,
        })),
        {
          value: "on",
          label: "on",
          description: "Enable footer",
        },
        {
          value: "off",
          label: "off",
          description: "Disable footer",
        },
      ];

      if (!argumentPrefix) return allOptions;

      const prefix = argumentPrefix.toLowerCase();
      const filtered = allOptions.filter(o =>
        o.value.toLowerCase().startsWith(prefix),
      );
      return filtered.length > 0 ? filtered : null;
    },
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

      const arg = args.trim().toLowerCase();

      // on / off
      if (arg === "on") {
        state.enabled = true;
        state.renderer.setActive(true);
        saveFooterSettings({ enabled: true });
        ctx.ui.notify("Footer enabled", "info");
        return;
      }
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

      // sep:<style> — change separator
      if (arg.startsWith("sep:")) {
        const style = arg.slice(4) as SeparatorStyle;
        if (SEPARATOR_STYLES.includes(style)) {
          saveFooterSettings({ separator: style });
          state.renderer.resetLayoutCache();
          ctx.ui.notify(`Separator: ${style}`, "info");
          return;
        }
        ctx.ui.notify(`Unknown separator. Available: ${SEPARATOR_STYLES.join(", ")}`, "warning");
        return;
      }

      // icon:<style> — change icon style
      if (arg.startsWith("icon:")) {
        const style = arg.slice(5) as IconStyle;
        if (ICON_STYLES.includes(style)) {
          saveFooterSettings({ iconStyle: style });
          setIconStyle(style);
          state.renderer.resetLayoutCache();
          ctx.ui.notify(`Icon style: ${style}`, "info");
          return;
        }
        ctx.ui.notify(`Unknown icon style. Available: ${ICON_STYLES.join(", ")}`, "warning");
        return;
      }

      // Preset name
      if (PRESET_NAMES.includes(arg)) {
        state.renderer.setPreset(arg);
        saveFooterSettings({ preset: arg });
        ctx.ui.notify(`Footer preset: ${arg}`, "info");
        return;
      }

      ctx.ui.notify(`Unknown argument. Use a preset (${PRESET_NAMES.join(", ")}), sep:<style>, icon:<style>, on, or off`, "info");
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
        showFooterSettings(ctx, groups);
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
}
