/**
 * @pi-unipi/utility — Command registration
 *
 * Registers /unipi:continue command for clean agent continuation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";

/**
 * Register utility commands.
 */
export function registerUtilityCommands(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.CONTINUE}`, {
    description: "Continue the agent from where it left off without adding user context",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.isIdle()) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Agent is busy. Press ESC to interrupt, then try again.",
            "warning",
          );
        }
        return;
      }

      // Send custom message to trigger a turn without polluting transcript
      pi.sendMessage(
        {
          customType: "unipi-continue",
          content: "",
          display: false,
        },
        { triggerTurn: true },
      );
    },
  });
}
