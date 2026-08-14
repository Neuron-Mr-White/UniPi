import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { RALPH_COMPLETE_MARKER } from "@pi-unipi/core";

export const RALPH_REMINDER_TYPE = "unipi-ralph-loop-reminder";

export interface RalphReminderInput {
  name: string;
  iteration: number;
  maxIterations: number;
  taskFile: string;
  itemsPerIteration: number;
}

/** Build the exact deterministic hidden reminder used by the live hook. */
export function buildRalphLoopReminder(state: RalphReminderInput): string {
  const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
  let instructions = "This snapshot supersedes all earlier Ralph loop reminders.\n";
  instructions += `You are in a Ralph loop working on: ${state.taskFile}\n`;
  if (state.itemsPerIteration > 0) {
    instructions += `- Work on ~${state.itemsPerIteration} items this iteration\n`;
  }
  instructions += "- Update the task file as you progress\n";
  instructions += `- When FULLY COMPLETE: ${RALPH_COMPLETE_MARKER}\n`;
  instructions += "- Otherwise, call ralph_done tool to proceed to next iteration";
  return `[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`;
}

export function latestRalphReminder(ctx: Pick<ExtensionContext, "sessionManager">): string | null {
  const branch = ctx.sessionManager.getBranch() as SessionEntry[];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom_message" && entry.customType === RALPH_REMINDER_TYPE) {
      return typeof entry.content === "string" ? entry.content : null;
    }
    // A compacted summary may contain the old reminder but no longer retains a
    // dedicated custom entry. Inject the current snapshot once in the new epoch.
    if (entry.type === "compaction") break;
  }
  return null;
}
