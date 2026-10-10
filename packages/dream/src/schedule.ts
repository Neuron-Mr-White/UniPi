/**
 * @pi-unipi/dream — schedule + state.
 *
 * State lives at stateDir("dream", "state", cwd)/state.json:
 *   { lastRunAt, sessionsSeen, lock: { pid, at } | null,
 *     decisions: { "<proposal id>": "approved" | "rejected" },
 *     shownReport: "<staging dir>" | null, dismissed: ["staging-…"] }
 *
 * A dream is due when the settings allow it, enough new sessions have landed
 * since the last run, the gap is respected, and no live lock exists.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stateDir } from "@pi-unipi/core";
import type { DreamSettings } from "./settings.ts";

export interface DreamState {
  lastRunAt: number;
  sessionsSeen: number;
  lock: { pid: number; at: number } | null;
  decisions: Record<string, "approved" | "rejected">;
  shownReport: string | null;
  /** Staging dir basenames the user dismissed from the tray/app list. */
  dismissed?: string[];
}

export const EMPTY_STATE: DreamState = {
  lastRunAt: 0,
  sessionsSeen: 0,
  lock: null,
  decisions: {},
  shownReport: null,
};

export function dreamStatePath(cwd: string): string {
  return path.join(stateDir("dream", "state", cwd), "state.json");
}

export function readDreamState(cwd: string): DreamState {
  try {
    const raw = JSON.parse(fs.readFileSync(dreamStatePath(cwd), "utf8")) as Partial<DreamState>;
    return {
      lastRunAt: typeof raw.lastRunAt === "number" ? raw.lastRunAt : 0,
      sessionsSeen: typeof raw.sessionsSeen === "number" ? raw.sessionsSeen : 0,
      lock: raw.lock && typeof raw.lock.pid === "number" ? { pid: raw.lock.pid, at: Number(raw.lock.at) || 0 } : null,
      decisions: raw.decisions && typeof raw.decisions === "object" ? raw.decisions : {},
      shownReport: typeof raw.shownReport === "string" ? raw.shownReport : null,
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((d): d is string => typeof d === "string") : [],
    };
  } catch {
    return { ...EMPTY_STATE, decisions: {}, dismissed: [] };
  }
}

export function writeDreamState(cwd: string, state: DreamState): void {
  try {
    fs.writeFileSync(dreamStatePath(cwd), JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: a failed state write must never break a session.
  }
}

export function isLockLive(lock: DreamState["lock"], now = Date.now()): boolean {
  if (!lock) return false;
  if (now - lock.at > 2 * 60 * 60 * 1000) return false; // stale after 2h
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface DueResult {
  due: boolean;
  reason: string;
  newSessions: number;
}

export function isDue(state: DreamState, newSessions: number, cfg: DreamSettings, now = Date.now()): DueResult {
  if (!cfg.enabled) return { due: false, reason: "disabled in settings", newSessions };
  if (isLockLive(state.lock, now)) return { due: false, reason: `dream already running (pid ${state.lock?.pid})`, newSessions };
  if (state.lastRunAt > 0 && now - state.lastRunAt < cfg.minGapHours * 60 * 60 * 1000) {
    const hours = ((now - state.lastRunAt) / 3_600_000).toFixed(1);
    return { due: false, reason: `min gap not reached (${hours}h of ${cfg.minGapHours}h)`, newSessions };
  }
  const since = state.lastRunAt === 0 ? state.sessionsSeen : state.sessionsSeen;
  if (newSessions - since < cfg.minSessions) {
    return { due: false, reason: `needs ${cfg.minSessions - (newSessions - since)} more new sessions`, newSessions };
  }
  return { due: true, reason: `${newSessions - since} new sessions since last dream`, newSessions };
}
