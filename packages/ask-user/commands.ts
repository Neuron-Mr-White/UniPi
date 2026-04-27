/**
 * @pi-unipi/ask-user — Command registration
 *
 * Registers optional test command for ask_user tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX } from "@pi-unipi/core";

/**
 * Register ask-user commands.
 */
export function registerAskUserCommands(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}ask-user-test`, {
    description: "Test the ask_user tool with a sample question",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI) {
        if (ctx.hasUI) {
          ctx.ui.notify("ask_user test requires an interactive UI.", "warning");
        }
        return;
      }

      // The test command just notifies — actual testing happens via tool call
      if (ctx.hasUI) {
        ctx.ui.notify(
          "To test ask_user, ask the agent to ask you a question using the ask_user tool.",
          "info",
        );
      }
    },
  });
}
