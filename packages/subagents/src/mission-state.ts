/**
 * @pi-unipi/subagents — Mission workflow state (state.get/set)
 *
 * Ported from pi-subagents src/missions/workflow-state.ts. Durable JSON
 * key/value state shared across workflows attached to the same mission:
 * each set takes a lock file, merges the key, enforces a strict 256 KiB
 * total-size limit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, waitForFileSystemRetry } from "./file-system-retry.js";

export const MISSION_STATE_MAX_BYTES = 256 * 1024;

interface StateFile {
  version: 1;
  values: Record<string, unknown>;
}

function statePath(missionDir: string, missionId: string): string {
  return path.join(missionDir, `${missionId}.state.json`);
}

function readState(file: string): StateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StateFile;
    if (parsed.version === 1 && parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values)) {
      return parsed;
    }
  } catch {
    // Missing/corrupt → fresh state.
  }
  return { version: 1, values: {} };
}

function validateKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
    throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
  }
  return key;
}

function withStateLock<T>(lockPath: string, operation: () => T): T {
  const owner = { pid: process.pid, token: randomUUID() };
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      try {
        fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
      } catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Stale-lock reclaim via pid probe (reference behavior).
      try {
        const ownerRaw = fs.readFileSync(path.join(lockPath, "owner.json"), "utf8");
        const held = JSON.parse(ownerRaw) as { pid?: number };
        if (held.pid && held.pid > 0) {
          try {
            process.kill(held.pid, 0);
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code !== "EPERM") {
              fs.rmSync(lockPath, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch {
        // Unreadable owner → age-based fallback below.
      }
      const delay = DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw new Error("Timed out acquiring mission state lock.");
      waitForFileSystemRetry(delay);
    }
  }
  try {
    return operation();
  } finally {
    try {
      const ownerRaw = fs.readFileSync(path.join(lockPath, "owner.json"), "utf8");
      if (JSON.parse(ownerRaw).token === owner.token) fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

export interface MissionWorkflowState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** Create the state adapter for one mission. */
export function createMissionWorkflowState(missionDir: string, missionId: string): MissionWorkflowState {
  const file = statePath(missionDir, missionId);
  const lock = `${file}.lock`;

  return {
    get(key: string): unknown {
      validateKey(key);
      return withStateLock(lock, () => {
        const state = readState(file);
        return state.values[key];
      });
    },
    set(key: string, value: unknown): void {
      validateKey(key);
      withStateLock(lock, () => {
        const state = readState(file);
        state.values[key] = value;
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized, "utf8") > MISSION_STATE_MAX_BYTES) {
          throw new Error(
            `Mission state exceeds the strict ${MISSION_STATE_MAX_BYTES} byte limit; remove keys or store large data in files.`,
          );
        }
        writePrivateAtomic(file, serialized);
      });
    },
  };
}

function writePrivateAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
