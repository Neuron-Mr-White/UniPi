/**
 * @unipi/ralph — Ralph tools (ralph_start, ralph_done)
 *
 * Tools for the LLM to control ralph loops.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { RALPH_COMPLETE_MARKER, RALPH_DEFAULTS, RALPH_TOOLS } from "@pi-unipi/core";
import { RalphLoopManager, DEFAULT_REFLECT_INSTRUCTIONS } from "./ralph-loop.js";

/**
 * Register ralph_start and ralph_done tools.
 */
export function registerRalphTools(pi: ExtensionAPI, manager: RalphLoopManager): void {
  // --- ralph_start tool ---
  pi.registerTool({
    name: RALPH_TOOLS.START,
    label: "Start Ralph Loop",
    description:
      "Start a long-running development loop. Use for complex multi-iteration tasks.",
    promptSnippet:
      "Start a persistent multi-iteration development loop with pacing and reflection controls.",
    promptGuidelines: [
      "Use ralph_start when the user explicitly wants an iterative loop, autonomous repeated passes, or paced multi-step execution.",
      "After starting a loop, continue each finished iteration with ralph_done unless the completion marker has already been emitted.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Loop name (e.g., 'refactor-auth')" }),
      taskContent: Type.String({
        description: "Task in markdown with goals and checklist",
      }),
      itemsPerIteration: Type.Optional(
        Type.Number({ description: "Suggest N items per turn (0 = no limit)" }),
      ),
      reflectEvery: Type.Optional(
        Type.Number({ description: "Reflect every N iterations" }),
      ),
      maxIterations: Type.Optional(
        Type.Number({
          description: "Max iterations (default: 50)",
          default: RALPH_DEFAULTS.MAX_ITERATIONS,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const taskFile = `.unipi/ralph/${params.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.md`;

      if (manager.loadState(params.name)?.status === "active") {
        return {
          content: [
            { type: "text", text: `Loop "${params.name}" already active.` },
          ],
          details: {},
        };
      }

      const state = manager.startLoop(params.name, taskFile, params.taskContent, {
        maxIterations: params.maxIterations,
        itemsPerIteration: params.itemsPerIteration,
        reflectEvery: params.reflectEvery,
      });

      pi.sendUserMessage(
        manager.buildPrompt(state, params.taskContent, false),
        { deliverAs: "followUp" },
      );

      return {
        content: [
          {
            type: "text",
            text: `Started loop "${params.name}" (max ${state.maxIterations} iterations).`,
          },
        ],
        details: {},
      };
    },
  });

  // --- ralph_done tool ---
  pi.registerTool({
    name: RALPH_TOOLS.DONE,
    label: "Ralph Iteration Done",
    description:
      "Signal that you've completed this iteration of the Ralph loop. Call this after making progress to get the next iteration prompt. Do NOT call this if you've output the completion marker.",
    promptSnippet:
      "Advance an active Ralph loop after completing the current iteration.",
    promptGuidelines: [
      "Call ralph_done after making real iteration progress so Ralph can queue the next prompt.",
      "Do not call ralph_done if there is no active loop, if pending messages are already queued, or if the completion marker has already been emitted.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!manager.getCurrentLoop()) {
        return {
          content: [{ type: "text", text: "No active Ralph loop." }],
          details: {},
        };
      }

      if (ctx.hasPendingMessages()) {
        return {
          content: [
            {
              type: "text",
              text: "Pending messages already queued. Skipping ralph_done.",
            },
          ],
          details: {},
        };
      }

      const result = manager.advanceIteration();
      if (!result) {
        return {
          content: [
            { type: "text", text: "Ralph loop completed or not active." },
          ],
          details: {},
        };
      }

      const { state, needsReflection } = result;
      const content = manager.tryReadTask(state);
      if (!content) {
        manager.pauseLoop(state);
        return {
          content: [
            {
              type: "text",
              text: `Error: Could not read task file: ${state.taskFile}`,
            },
          ],
          details: {},
        };
      }

      // Queue next iteration
      pi.sendUserMessage(
        manager.buildPrompt(state, content, needsReflection),
        { deliverAs: "followUp" },
      );

      return {
        content: [
          {
            type: "text",
            text: `Iteration ${state.iteration - 1} complete. Next iteration queued.`,
          },
        ],
        details: {},
      };
    },
  });
}
