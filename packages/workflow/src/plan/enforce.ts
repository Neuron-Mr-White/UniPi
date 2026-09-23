/**
 * Plan-mode enforcement — runs BEFORE the permission gate.
 *
 * While plan mode is active the session is read-only: the only writable file is
 * the plan file, bash must be a read-only command (no jev), and every other
 * mutating tool is refused.
 */

import { resolve } from "node:path";
import { classifyBash } from "../permission/bash.js";
import { READ_ONLY_TOOLS } from "../permission/decide.js";
import { displayPlanPath, type PlanSessionState } from "./state.js";

/** Read-only tools plus the two tools planning explicitly keeps. */
export const PLAN_ALLOWED_TOOLS = new Set([...READ_ONLY_TOOLS, "ask_user", "plan_submit"]);

export interface PlanBlock {
  block: true;
  reason: string;
}

export function planBlockReason(planFile: string | null, cwd: string, why: string): PlanBlock {
  const path = displayPlanPath(cwd, planFile);
  return {
    block: true,
    reason:
      `Plan mode is read-only. ${why} ` +
      `Write your plan to ${path} and call plan_submit.`,
  };
}

export function enforcePlanMode(
  input: { toolName: string; subject: string },
  state: PlanSessionState,
  cwd: string,
): PlanBlock | undefined {
  if (!state.active) return undefined;

  const tool = input.toolName;

  if (tool === "write" || tool === "edit") {
    const target = resolve(cwd, input.subject);
    if (state.planFile && target === resolve(state.planFile)) return undefined;
    return planBlockReason(state.planFile, cwd, "Only the plan file may be written.");
  }

  if (tool === "bash") {
    const verdict = classifyBash(input.subject);
    if (verdict.kind === "read_only") return undefined;
    return planBlockReason(
      state.planFile,
      cwd,
      `Bash is limited to read-only commands (${verdict.reason}).`,
    );
  }

  if (PLAN_ALLOWED_TOOLS.has(tool)) return undefined;
  return planBlockReason(state.planFile, cwd, `The "${tool}" tool is not available while planning.`);
}
