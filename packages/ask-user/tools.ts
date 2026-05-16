/**
 * @pi-unipi/ask-user — Tool registration
 *
 * Registers ask_user tool for structured user input.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  ASK_USER_TOOLS,
  COMPACTOR_INSTRUCTION,
  UNIPI_EVENTS,
  emitEvent,
} from "@pi-unipi/core";
import type { NormalizedOption, AskUserResponse, SessionLauncherResult } from "./types.js";
import { renderAskUI, createRenderCall, createRenderResult } from "./ask-ui.js";
import { renderLauncherUI } from "./launcher-ui.js";
import { getAskUserSettings } from "./config.js";
import { queueCompactHandoff, queueDirectHandoff } from "./handoff.js";

/**
 * Register ask-user tools.
 */
export function registerAskUserTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ASK_USER_TOOLS.ASK,
    label: "Ask User",
    description:
      "Ask the user a question with structured options. Supports single-select, " +
      "multi-select, and freeform text input. Use for decisions, preferences, " +
      "and clarifications that require explicit user input.",
    promptSnippet: "Ask the user a structured question with options.",
    promptGuidelines: [
      "Use ask_user when you need explicit user input before proceeding.",
      "Good for: architectural trade-offs, ambiguous requirements, user preferences, confirming destructive operations.",
      "Provide clear options with labels and optional descriptions.",
      "Use allowMultiple for multi-select scenarios (e.g., choosing features to enable).",
      "Use allowFreeform: false to restrict to predefined options only.",
      "Use action: 'input' on an option to let the user add custom text before submitting.",
      "Use action: 'end_turn' on an option to let the user signal end of turn.",
      "Use action: 'new_session' with prefill to let the user hand off to a queued follow-up message or slash command."
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "The question to ask the user",
      }),
      context: Type.Optional(
        Type.String({
          description: "Additional context shown before the question",
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({ description: "Display label" }),
            description: Type.Optional(
              Type.String({ description: "Optional description shown below label" }),
            ),
            value: Type.Optional(
              Type.String({
                description: "Value returned when selected (defaults to label)",
              }),
            ),
            allowCustom: Type.Optional(
              Type.Boolean({
                description:
                  "When true, selecting this option enters text input mode " +
                  "so the user can add a custom comment before submitting.",
              }),
            ),
            action: Type.Optional(
              Type.Union(
                [
                  Type.Literal("select"),
                  Type.Literal("input"),
                  Type.Literal("end_turn"),
                  Type.Literal("new_session"),
                ],
                {
                  description:
                    "Special action: 'select' (default), 'input' (text input), " +
                    "'end_turn' (signal end of turn), 'new_session' (queue handoff with prefill).",
                },
              ),
            ),
            prefill: Type.Optional(
              Type.String({
                description: "Prefill message for new_session action.",
              }),
            ),
          }),
          {
            description:
              "Multiple-choice options. Omit for freeform-only input.",
          },
        ),
      ),
      allowMultiple: Type.Optional(
        Type.Boolean({
          description: "Enable multi-select mode (default: false)",
        }),
      ),
      allowFreeform: Type.Optional(
        Type.Boolean({
          description: "Allow freeform text input (default: true)",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Auto-dismiss after N milliseconds",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const {
        question,
        context,
        options: rawOptions,
        allowMultiple = false,
        allowFreeform = true,
        timeout,
      } = params as {
        question: string;
        context?: string;
        options?: { label: string; description?: string; value?: string; allowCustom?: boolean; action?: string; prefill?: string }[];
        allowMultiple?: boolean;
        allowFreeform?: boolean;
        timeout?: number;
      };

      // Check settings
      const settings = getAskUserSettings();
      if (!settings.enabled) {
        return {
          content: [
            {
              type: "text",
              text: "Error: ask_user tool is disabled in settings.",
            },
          ],
          details: {
            question,
            response: {
              kind: "cancelled",
              comment: "Tool disabled",
            } as AskUserResponse,
          },
        };
      }

      // Validate requested format against allowed formats
      if (allowMultiple && !settings.allowedFormats.multiSelect) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Multi-select questions are disabled in settings.",
            },
          ],
          details: {
            question,
            response: {
              kind: "cancelled",
              comment: "Multi-select disabled",
            } as AskUserResponse,
          },
        };
      }

      if (!allowMultiple && !settings.allowedFormats.singleSelect) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Single-select questions are disabled in settings.",
            },
          ],
          details: {
            question,
            response: {
              kind: "cancelled",
              comment: "Single-select disabled",
            } as AskUserResponse,
          },
        };
      }

      if (allowFreeform && !settings.allowedFormats.freeform) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Freeform questions are disabled in settings.",
            },
          ],
          details: {
            question,
            response: {
              kind: "cancelled",
              comment: "Freeform disabled",
            } as AskUserResponse,
          },
        };
      }

      // Validate: need UI
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Error: UI not available (running in non-interactive mode)",
            },
          ],
          details: {
            question,
            response: {
              kind: "cancelled",
              comment: "No UI available",
            } as AskUserResponse,
          },
        };
      }

      // Validate: need options or freeform
      const options = rawOptions || [];
      if (options.length === 0 && !allowFreeform) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No options provided and allowFreeform is false. Provide options or enable freeform.",
            },
          ],
          details: {
            question,
            response: {
              kind: "cancelled",
              comment: "No options and no freeform",
            } as AskUserResponse,
          },
        };
      }

      // Normalize options — resolve value (defaults to label)
      const normalizedOptions: NormalizedOption[] = options.map((opt) => ({
        label: opt.label,
        description: opt.description,
        value: opt.value ?? opt.label,
        allowCustom: opt.allowCustom ?? false,
        action: (opt.action as NormalizedOption["action"]) ?? "select",
        prefill: opt.prefill,
      }));
      const detailsBase = {
        question,
        context,
        options: normalizedOptions,
        allowMultiple,
        allowFreeform,
      };

      // Emit ASK_USER_PROMPT event if notifyOnAsk is enabled
      if (settings.notifyOnAsk) {
        emitEvent(pi, UNIPI_EVENTS.ASK_USER_PROMPT, {
          question,
          context,
          optionCount: normalizedOptions.length,
          allowMultiple,
          allowFreeform,
        });
      }

      // Render interactive UI
      const result = await ctx.ui.custom<{ response: AskUserResponse } | null>(
        renderAskUI({
          question,
          context,
          options: normalizedOptions,
          allowMultiple,
          allowFreeform,
          timeout,
        }),
      );

      // Handle cancel
      if (!result) {
        return {
          content: [
            {
              type: "text",
              text: "User cancelled the selection",
            },
          ],
          details: {
            ...detailsBase,
            response: {
              kind: "cancelled",
            } as AskUserResponse,
          },
        };
      }

      // Build response content
      const response = result.response;
      let contentText: string;

      switch (response.kind) {
        case "selection": {
          const selections = response.selections || [];
          contentText =
            selections.length === 1
              ? `User selected: ${selections[0]}`
              : `User selected: ${selections.join(", ")}`;
          break;
        }
        case "freeform":
          contentText = `User wrote: ${response.text}`;
          break;
        case "combined": {
          const selections = response.selections || [];
          const selText = selections.length === 1
            ? selections[0]
            : selections.join(", ");
          contentText = `User selected: ${selText} and wrote: ${response.text}`;
          break;
        }
        case "end_turn":
          // Abort the agent immediately — no LLM follow-up, no wasted tokens.
          // The tool result is still recorded in session history.
          ctx.abort();
          contentText = "User chose to end the turn.";
          break;
        case "new_session":
          contentText = response.prefill
            ? `User chose to hand off to: ${response.prefill}`
            : "User chose a handoff without a prefill.";
          break;
        case "timed_out":
          contentText = "User did not respond (timed out)";
          break;
        default:
          contentText = "No response";
      }

      // Session launcher intercept: when user selects new_session, offer compact/direct/cancel
      if (response.kind === "new_session") {
        const prefill = response.prefill || "";
        const launcherResult = await ctx.ui.custom<SessionLauncherResult | null>(
          renderLauncherUI({ prefill }),
        );

        if (!launcherResult || launcherResult.action === "cancel") {
          return {
            content: [{ type: "text", text: "User cancelled the session launch" }],
            details: {
              ...detailsBase,
              response: {
                kind: "cancelled",
                comment: "Session launcher cancelled",
              } as AskUserResponse,
            },
          };
        }

        const handoff = launcherResult.action === "compact"
          ? queueCompactHandoff({
              pi,
              ctx,
              prefill,
              // Use the compactor sentinel so @pi-unipi/compactor's zero-LLM
              // pipeline intercepts. If compactor is not installed, Pi's built-in
              // LLM-based compaction runs instead.
              customInstructions: `${COMPACTOR_INSTRUCTION}\nPreparing for new task. Summarize previous work concisely, preserving only what's essential for: ${prefill}`,
            })
          : queueDirectHandoff(pi, ctx, prefill);

        if (handoff.status === "cancelled") {
          return {
            content: [{ type: "text", text: "Session launch cancelled: no prefill message was provided." }],
            details: {
              ...detailsBase,
              response: {
                kind: "cancelled",
                comment: "Session launcher had no prefill to queue",
                launchStatus: handoff.status,
                launchReason: handoff.reason,
              } as AskUserResponse,
            },
          };
        }

        if (handoff.status !== "failed") {
          // Handoff is scheduled/queued or recoverably editor-prefilled; abort the
          // current turn so the queued command can run without LLM follow-up.
          ctx.abort();
        }

        const launchLabel = launcherResult.action === "compact" ? "compact" : "direct";
        if (handoff.status === "editor_prefill") {
          contentText = `Queued ${launchLabel} handoff fell back to editor prefill: ${handoff.prefill}`;
        } else if (handoff.status === "failed") {
          contentText = `Failed to queue ${launchLabel} handoff: ${handoff.prefill ?? prefill}`;
        } else {
          contentText = `Queued ${launchLabel} handoff: ${handoff.prefill ?? prefill}`;
        }

        return {
          content: [{ type: "text", text: contentText }],
          details: {
            ...detailsBase,
            response: {
              ...response,
              prefill: handoff.prefill ?? prefill,
              launchedWith: launcherResult.action,
              launchStatus: handoff.status,
              launchReason: handoff.reason,
              launchError: handoff.error,
            },
          },
        };
      }

      return {
        content: [{ type: "text", text: contentText }],
        details: {
          ...detailsBase,
          response,
        },
      };
    },

    renderCall: createRenderCall(),
    renderResult: createRenderResult(),
  });
}
