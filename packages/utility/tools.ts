/**
 * @pi-unipi/utility — Tool registration
 *
 * Registers continue_task tool for programmatic agent continuation.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UTILITY_TOOLS } from "@pi-unipi/core";
import { CONTINUE_PROMPT } from "./constants.js";

/**
 * Register utility tools.
 */
export function registerUtilityTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: UTILITY_TOOLS.CONTINUE,
    label: "Continue Task",
    description:
      "Signal that the agent should continue working on the current task " +
      "without waiting for user input. Use when the agent has finished one " +
      "step and should proceed to the next.",
    promptSnippet: "Continue working on the current task without user input.",
    promptGuidelines: [
      "Use continue_task when you finish a step and need to proceed to the next without waiting for the user.",
      "Do not use if there are pending messages already queued.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      if (!ctx.isIdle()) {
        return {
          content: [
            {
              type: "text",
              text: "Agent is busy. Cannot send continue message right now.",
            },
          ],
          details: { sent: false, reason: "busy" },
        };
      }

      if (ctx.hasPendingMessages()) {
        return {
          content: [
            {
              type: "text",
              text: "Pending messages already queued. Skipping continue.",
            },
          ],
          details: { sent: false, reason: "pending" },
        };
      }

      pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "steer" });

      return {
        content: [
          {
            type: "text",
            text: "Continue message sent. Agent will proceed to the next step.",
          },
        ],
        details: { sent: true },
      };
    },
  });
}
