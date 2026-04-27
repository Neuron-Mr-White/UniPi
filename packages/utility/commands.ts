/**
 * @pi-unipi/utility — Command registration
 *
 * Registers /unipi:continue command for clean agent continuation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, UTILITY_COMMANDS } from "@pi-unipi/core";
import { CONTINUE_PROMPT } from "./constants.js";

/**
 * Register utility commands.
 */
export function registerUtilityCommands(pi: ExtensionAPI): void {
  pi.registerCommand(`${UNIPI_PREFIX}${UTILITY_COMMANDS.CONTINUE}`, {
    description: "Continue the agent from where it left off without adding user context",
    argumentHint: "",
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

      // Send steer message — continues agent without polluting transcript
      pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "steer" });
    },
  });
}
