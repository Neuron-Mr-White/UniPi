/**
 * Ralph tools — the loop's model-facing surface.
 *
 *   ralph_done    lease-guarded iteration yield (advances the loop or claims
 *                 completion; the verifier judges all-checked claims)
 *   loop_status   read-only loop + task-file progress
 *
 * ralph_start stays command-side (users author the task file). Design §4:
 * "ralph is ralph, goal is goal" — these are the only loop controls the
 * model sees in ralph mode.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RalphLoop } from "../engine/ralph.js";
import { parseChecklist, RALPH_COMPLETE_MARKER } from "../engine/ralph.js";

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

export function registerRalphTools(pi: ExtensionAPI, loop: RalphLoop): void {
  pi.registerTool({
    name: "ralph_done",
    label: "Ralph Done",
    description:
      "Yield the current ralph iteration. Checks the task file: if items remain, the next " +
      "iteration prompt arrives with the next unchecked items; if every item is checked, the " +
      "independent verifier judges the file and the loop completes (or reports what is missing). " +
      "Call once per iteration after updating the task file.",
    parameters: Type.Object({}),
    execute: async () => {
      const result = loop.onRalphDone();
      if (!result.ok) {
        return textResult(`ralph_done rejected: ${result.reason}`);
      }
      if (result.completionClaim) {
        const verdict = await loop.verifyCompletion();
        if (verdict.kind === "met") {
          return textResult(
            `Loop complete — the verifier accepted the checklist (${verdict.reason}). ` +
              "Report the final summary to the user.",
          );
        }
        if (verdict.kind === "not_met") {
          return textResult(
            `Verifier rejected the completion claim: ${verdict.reason}` +
              (verdict.missing.length > 0 ? `\nMissing evidence: ${verdict.missing.join("; ")}` : "") +
              "\nUncheck or finish the remaining work; the next iteration continues.",
          );
        }
        return textResult(
          `Verifier was inconclusive (${verdict.reason}); the loop continues next iteration.`,
        );
      }
      return textResult(
        `Iteration yielded. Next iteration dispatched${result.prompt ? "" : " (no prompt rendered)"}. ` +
          `When every item is checked and verified, the final ralph_done completes the loop; ` +
          `do not emit ${RALPH_COMPLETE_MARKER} manually.`,
      );
    },
  });

  pi.registerTool({
    name: "loop_status",
    label: "Loop Status",
    description:
      "Read the current ralph loop state: iteration, cadence, and task-file progress " +
      "(checked/total, next items).",
    parameters: Type.Object({}),
    execute: async () => {
      const state = loop.get();
      if (!state) return textResult("No loop state in this session.");
      const summary = loop.progressSummary();
      return textResult(
        JSON.stringify(
          {
            name: state.name,
            iteration: state.iteration,
            ...(state.maxIterations > 0 ? { max_iterations: state.maxIterations } : {}),
            items_per_iteration: state.itemsPerIteration,
            reflect_every: state.reflectEvery,
            status: state.status,
            task_file: `.unipi/ralph/${state.taskFile}`,
            progress: summary,
          },
          null,
          2,
        ),
      );
    },
  });
}
