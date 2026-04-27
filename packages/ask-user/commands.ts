/**
 * @pi-unipi/ask-user — Command registration
 *
 * Registers settings command for ask_user tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";
import { AskUserSettingsOverlay } from "./settings-tui.js";

/**
 * Register ask-user commands.
 */
export function registerAskUserCommands(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}ask-user-settings`, {
    description: "Configure ask_user tool settings",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        if (ctx.hasUI) {
          ctx.ui.notify("Settings require an interactive UI.", "warning");
        }
        return;
      }

      ctx.ui.custom(
        (tui: any, _theme: any, _keybindings: any, done: any) => {
          const overlay = new AskUserSettingsOverlay();
          overlay.onClose = () => done(undefined);
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "80%",
            minWidth: 60,
            anchor: "center",
            margin: 2,
          },
        },
      );
    },
  });
}
