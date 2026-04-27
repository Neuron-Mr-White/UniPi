/**
 * @pi-unipi/ask-user — Tool registration
 *
 * Registers ask_user tool for structured user input.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ASK_USER_TOOLS } from "@pi-unipi/core";
import type { NormalizedOption, AskUserResponse } from "./types.js";
import { renderAskUI, createRenderCall, createRenderResult } from "./ask-ui.js";
import { getAskUserSettings } from "./config.js";

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
        options?: { label: string; description?: string; value?: string }[];
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
      }));

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
            question,
            options: normalizedOptions.map((o) => o.label),
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
        case "timed_out":
          contentText = "User did not respond (timed out)";
          break;
        default:
          contentText = "No response";
      }

      return {
        content: [{ type: "text", text: contentText }],
        details: {
          question,
          options: normalizedOptions.map((o) => o.label),
          response,
        },
      };
    },

    renderCall: createRenderCall(),
    renderResult: createRenderResult(),
  });
}
