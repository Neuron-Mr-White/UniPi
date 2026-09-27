/**
 * Active-work brief for compaction summaries: what the goal / ralph loop is
 * doing right now, from durable state rather than transcript guesses.
 */

import type { GoalState } from "./engine/goal-state.js";
import type { LoopFileState } from "./engine/ralph.js";

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function longHorizonCompactionBrief(
  goal: GoalState | null,
  loop: LoopFileState | null,
  ralphDir: string,
): string | null {
  const lines: string[] = [];
  if (loop && loop.status === "active") {
    const max = loop.maxIterations > 0 ? `/${loop.maxIterations}` : "";
    lines.push(
      `Ralph loop "${loop.name}" is running — iteration ${loop.iteration}${max}.`,
      `Task file (the checklist is the source of truth, re-read it): ${ralphDir}/${loop.taskFile}`,
      "Work the next unchecked items, update the task file, then call ralph_done.",
    );
  } else if (goal && goal.status === "active") {
    const stall = goal.noProgressStreak > 0 ? `, ${goal.noProgressStreak}/${goal.stallCap} no-progress` : "";
    lines.push(
      `Goal (active, turn ${goal.turn}/${goal.maxTurns}${stall}): "${clip(goal.objective, 700)}"`,
      "Keep working toward it; call get_goal for the durable state. Completion is judged by an independent verifier.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
