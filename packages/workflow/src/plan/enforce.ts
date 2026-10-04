/**
 * Plan-mode enforcement — runs BEFORE the permission gate.
 *
 * Deny-list, not allowlist: reads, research and read-only shell fall through to
 * the normal permission gate. Only writes are hard-blocked — anything outside
 * the plan file, `docs/plans/` and the temp dir, in every permission mode — and
 * state-changing bash asks the user first.
 */

import { join, resolve, sep } from "node:path";
import { classifyBash } from "../permission/bash.js";
import { displayPlanPath, type PlanSessionState } from "./state.js";

export interface PlanEnforceDeps {
  tmpdir: string;
}

export type PlanEnforcement =
  | { kind: "block"; reason: string }
  | { kind: "ask"; reason: string };

function isInsidePath(target: string, root: string): boolean {
  if (!root) return false;
  const normalizedRoot = resolve(root);
  const normalized = resolve(target);
  return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + sep);
}

export function planWriteBlockReason(planFile: string | null, cwd: string): string {
  return (
    `Plan mode: only the plan file (${displayPlanPath(cwd, planFile)}), docs/plans/ and temp files may be written. ` +
    "Put this change in the plan instead. If a route is denied twice, record the uncertainty in the plan rather than retrying."
  );
}

export function enforcePlanMode(
  input: { toolName: string; subject: string },
  state: PlanSessionState,
  cwd: string,
  deps: PlanEnforceDeps,
): PlanEnforcement | undefined {
  if (!state.active) return undefined;

  if (input.toolName === "write" || input.toolName === "edit") {
    const target = resolve(cwd, input.subject);
    if (state.planFile && target === resolve(state.planFile)) return undefined;
    if (isInsidePath(target, join(cwd, "docs", "plans"))) return undefined;
    if (isInsidePath(target, deps.tmpdir)) return undefined;
    return { kind: "block", reason: planWriteBlockReason(state.planFile, cwd) };
  }

  if (input.toolName === "bash") {
    const verdict = classifyBash(input.subject);
    if (verdict.kind === "read_only" || verdict.kind === "kanboard") return undefined;
    return { kind: "ask", reason: `plan mode · may change state: ${verdict.reason}` };
  }

  return undefined;
}
