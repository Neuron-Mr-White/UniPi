/**
 * Canonical unipi state layout (v3) — one root per workspace, three scopes.
 *
 *   ~/.unipi/config/<module>/…                      global user defaults
 *   ~/.unipi/global/<module>/…                      truly cross-project (model cache, images)
 *   ~/.unipi/workspace/<id>/config/<module>/…       project config overrides
 *   ~/.unipi/workspace/<id>/state/<module>/…        durable project state (memory, goals, ralph)
 *   ~/.unipi/workspace/<id>/sessions/<sid>/<module>/ ephemeral per-session state (GC'd)
 *
 * `<id>` is the workspace uuid from resolveWorkspaceIdentity (marker-file based,
 * so it survives repo moves and never collides). `<sid>` is `${id}-${pid}` — a
 * session key that KNOWS its workspace, so orphan sweeping can parse the pid and
 * reap dead sessions across every workspace on startup.
 *
 * Every module calls stateDir(module, scope) instead of hand-rolling
 * join(homedir(), ".unipi", …). That is the whole point: one predictable,
 * enumerable tree the settings hub can list and reset.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceId } from "./identity.js";

export type StateScope = "global" | "config" | "state" | "session";

export function unipiRoot(): string {
  return join(homedir(), ".unipi");
}

export function workspaceRoot(cwd: string = process.cwd()): string {
  return join(unipiRoot(), "workspace", workspaceId(cwd));
}

/** Session id: `<workspaceId>-<pid>`. Encodes the owning workspace + process. */
export function sessionId(cwd: string = process.cwd()): string {
  return `${workspaceId(cwd)}-${process.pid}`;
}

/** Parse the owner pid out of a `<workspaceId>-<pid>` session id. */
export function pidFromSessionId(sid: string): number | undefined {
  const m = /-(\d+)$/.exec(sid);
  if (!m) return undefined;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Resolve (and create) the directory for a module's state at a given scope.
 *
 *   global   ~/.unipi/global/<module>/
 *   config   ~/.unipi/workspace/<id>/config/<module>/
 *   state    ~/.unipi/workspace/<id>/state/<module>/
 *   session  ~/.unipi/workspace/<id>/sessions/<sid>/<module>/
 */
export function stateDir(
  module: string,
  scope: StateScope = "state",
  cwd: string = process.cwd(),
): string {
  let dir: string;
  switch (scope) {
    case "global":
      dir = join(unipiRoot(), "global", module);
      break;
    case "config":
      dir = join(workspaceRoot(cwd), "config", module);
      break;
    case "session":
      dir = join(workspaceRoot(cwd), "sessions", sessionId(cwd), module);
      break;
    case "state":
    default:
      dir = join(workspaceRoot(cwd), "state", module);
      break;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Directory creation is best-effort; callers handle write failures.
  }
  return dir;
}

/** A single file under a module's state dir. */
export function statePath(
  module: string,
  file: string,
  scope: StateScope = "state",
  cwd: string = process.cwd(),
): string {
  return join(stateDir(module, scope, cwd), file);
}

function isPidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → process exists but is owned by someone else (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Sweep session dirs whose owning process is gone, across every workspace.
 * Call once on session_start. Returns the number of session dirs removed.
 *
 * Only the current-session dir is guaranteed live; any other `sessions/<sid>`
 * whose parsed pid is dead (crashed/killed pi) is removed with its whole
 * subtree — this is what keeps ephemeral state (sidekick transcripts, bg
 * runtime, mode files) from accumulating forever.
 */
export function sweepOrphanSessions(): number {
  const workspacesDir = join(unipiRoot(), "workspace");
  let removed = 0;
  let workspaces: string[];
  try {
    workspaces = readdirSync(workspacesDir);
  } catch {
    return 0;
  }
  for (const ws of workspaces) {
    const sessionsDir = join(workspacesDir, ws, "sessions");
    let sids: string[];
    try {
      sids = readdirSync(sessionsDir);
    } catch {
      continue;
    }
    for (const sid of sids) {
      const pid = pidFromSessionId(sid);
      // Unparseable or dead-owner session dirs are orphans.
      if (pid !== undefined && isPidAlive(pid)) continue;
      try {
        rmSync(join(sessionsDir, sid), { recursive: true, force: true });
        removed++;
      } catch {
        // Best-effort; a locked dir is retried next startup.
      }
    }
    // Drop an empty sessions/ dir so idle workspaces stay tidy.
    try {
      if (readdirSync(sessionsDir).length === 0) rmSync(sessionsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  return removed;
}

/** Cap a live append-only artifact (e.g. sidekick jsonl) by size. */
export function isOverSizeCap(path: string, capBytes: number): boolean {
  try {
    return statSync(path).size > capBytes;
  } catch {
    return false;
  }
}
