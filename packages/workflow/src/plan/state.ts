/**
 * Plan-mode session state.
 *
 * Persisted as a pi custom entry (`unipi:plan-mode`) so a resume or a fork
 * restores the same plan file instead of starting a new one.
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PLAN_STATE_ENTRY = "unipi:plan-mode";
export const PLAN_MESSAGE_TYPE = "unipi:plan-mode-message";

export interface PlanSessionState {
  sessionId: string;
  active: boolean;
  /** Absolute path of the only file plan mode may write. */
  planFile: string | null;
}

let sessionState: PlanSessionState | null = null;

/** `<YYYY-MM-DD>-<short-session-id>` */
export function planFileName(sessionId: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const short = sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "session";
  return `${date}-${short}.md`;
}

export function planFilePath(cwd: string, sessionId: string): string {
  return resolve(cwd, ".unipi", "plans", planFileName(sessionId));
}

export function ensurePlanDir(planFile: string): void {
  mkdirSync(dirname(planFile), { recursive: true });
}

export function restorePlanState(
  sessionId: string,
  entries: ReadonlyArray<object>,
  cwd: string,
): PlanSessionState {
  sessionState = { sessionId, active: false, planFile: null };
  for (const entry of entries) {
    const customType = (entry as { customType?: string }).customType;
    if (customType !== PLAN_STATE_ENTRY) continue;
    const data = (entry as { data?: unknown }).data as
      | { active?: unknown; planFile?: unknown }
      | undefined;
    sessionState.active = data?.active === true;
    sessionState.planFile = typeof data?.planFile === "string" ? data.planFile : null;
  }
  if (sessionState.active && !sessionState.planFile) {
    sessionState.planFile = planFilePath(cwd, sessionId);
  }
  return sessionState;
}

export function resetPlanState(sessionId: string): PlanSessionState {
  sessionState = { sessionId, active: false, planFile: null };
  return sessionState;
}

export function currentPlanState(sessionId: string): PlanSessionState {
  if (!sessionState || sessionState.sessionId !== sessionId) resetPlanState(sessionId);
  return sessionState!;
}

/** The plan file for the active session, creating its directory. */
export function activePlanFile(cwd: string, sessionId: string): string {
  const state = currentPlanState(sessionId);
  const file = state.planFile ?? planFilePath(cwd, sessionId);
  ensurePlanDir(file);
  return file;
}

/** Absolute path used in messages (stable across cwd spelling). */
export function displayPlanPath(cwd: string, planFile: string | null): string {
  if (!planFile) return join(cwd, ".unipi", "plans");
  const rel = planFile.startsWith(cwd) ? planFile.slice(cwd.length + 1) : planFile;
  return rel;
}
