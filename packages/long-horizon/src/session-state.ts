/**
 * Session-scoped long-horizon state — a run belongs to the session that
 * started it (UNI-followup): every session reads/writes
 * `~/.unipi/workspace/<id>/state/long-horizon/sessions/<sessionId>/`, so a
 * `/new` or app "New chat" starts clean instead of adopting (and waking)
 * another session's graph.
 *
 * Pure helpers here (testable without pi): path layout, the "is this a
 * continued session" rule, adoption of legacy pre-split state, sibling
 * scans for the one-line warning and the read-only history aggregate, and
 * the >30-days housekeeping prune.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Files (and the ralph dir) that make up one session's long-horizon state. */
export const LH_SESSION_FILES = ["state.json", "goal.json", "graph.json"] as const;

/** `<workspace state>/long-horizon/sessions/<sessionId>/` — one dir per session. */
export function sessionStateDir(workspaceStateDir: string, sessionId: string): string {
  return join(workspaceStateDir, "sessions", sessionId);
}

/** The pre-split workspace-level dir (legacy, adopted once by a continued session). */
export function legacyWorkspaceDir(workspaceStateDir: string): string {
  return workspaceStateDir;
}

/** The older in-repo legacy dir (`<cwd>/.unipi/long-horizon`). */
export function legacyInRepoDir(cwd: string): string {
  return join(cwd, ".unipi", "long-horizon");
}

/**
 * A continued session keeps what its project was doing: `resume`/`reload`
 * explicitly, and a bare `startup` counts when the session file already has
 * entries (pi -r replays them). `new`/`fork` and an entry-less startup start
 * clean and never adopt.
 */
export function isContinuedSession(reason: string | undefined, priorEntryCount: number): boolean {
  if (reason === "resume" || reason === "reload") return true;
  if (reason === "new" || reason === "fork") return false;
  return priorEntryCount > 0;
}

/**
 * Does THIS session's own transcript prove it owned the legacy run? The
 * entries (stringified) must contain, for a graph/swarm owner, the legacy
 * graph's `current.graphId`; for a goal owner, the goal's id or objective;
 * for a ralph owner, the loop name. Without that, an unrelated `pi -r` of
 * some other session must NOT adopt (and then drive) the legacy run — that
 * would re-introduce exactly the cross-session wake bug. The sibling-owner
 * note still tells the user where the run lives.
 */
export function legacyOwnershipEvidence(entriesJson: string, legacyDirs: string[]): boolean {
  if (!entriesJson) return false;
  for (const dir of legacyDirs) {
    const state = readOwnerState(join(dir, "state.json"));
    const owner = state?.active ?? state?.parked;
    const kind = owner?.kind;
    if (kind === "graph" || kind === "swarm") {
      try {
        const graph = JSON.parse(readJsonFile(join(dir, "graph.json"))) as { current?: { graphId?: string } };
        const graphId = graph?.current?.graphId;
        if (graphId && entriesJson.includes(graphId)) return true;
      } catch {
        // No/bad graph.json: no graph evidence from this dir.
      }
    } else if (kind === "goal") {
      try {
        const goal = JSON.parse(readJsonFile(join(dir, "goal.json"))) as { goalId?: string; objective?: string };
        if ((goal?.goalId && entriesJson.includes(goal.goalId)) || (goal?.objective && entriesJson.includes(goal.objective))) return true;
      } catch {
        // No/bad goal.json.
      }
    } else if (kind === "ralph") {
      const loopName = owner?.label;
      if (loopName && entriesJson.includes(loopName)) return true;
    }
  }
  return false;
}

/**
 * Move legacy state (workspace-level and in-repo) into the session dir.
 * Only files the session dir lacks are moved; rename is atomic; the first
 * continued session wins (the source is gone afterwards). Returns what moved.
 */
export function adoptLegacyState(sessionDir: string, sources: string[], files: readonly string[]): string[] {
  const moved: string[] = [];
  if (existsSync(join(sessionDir, "state.json"))) return moved;
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch {
    return moved;
  }
  for (const source of sources) {
    for (const file of files) {
      const from = join(source, file);
      const to = join(sessionDir, file);
      if (!existsSync(to) && existsSync(from)) {
        try {
          renameSync(from, to);
          moved.push(from);
        } catch {
          // A failed move just means this session starts fresh at `to`.
        }
      }
    }
    // The ralph task-file dir moves whole.
    const fromDir = join(source, "ralph");
    const toDir = join(sessionDir, "ralph");
    if (!existsSync(toDir) && existsSync(fromDir)) {
      try {
        renameSync(fromDir, toDir);
        moved.push(fromDir);
      } catch {
        // Same: best-effort.
      }
    }
  }
  return moved;
}

// ── sibling scans ────────────────────────────────────────────────────────────

export interface SiblingGraphOwner {
  readonly sessionId: string;
  readonly kind: "graph" | "swarm";
  readonly label: string;
  /** Set when the state declares one (best-effort; the session file's name). */
  readonly sessionName?: string;
  /** The owner's pid when stamped (running vs paused in the warning). */
  readonly pid?: number;
  readonly updatedAt: string;
}

interface OwnerLike {
  active?: { kind?: string; label?: string; sessionId?: string; pid?: number };
  parked?: { kind?: string; label?: string; sessionId?: string; pid?: number };
  updatedAt?: string;
}

function readOwnerState(path: string): OwnerLike | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readJsonFile(path)) as OwnerLike;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Shim so this module needs no core import for one read. */
function readJsonFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Sibling sessions holding an active/parked graph|swarm owner that is NOT
 * this session's. `labelsById` maps session ids to names (best-effort).
 */
export function scanSiblingGraphOwners(
  sessionsDir: string,
  ownSessionId: string,
  ...legacyDirs: (string | undefined)[]
): SiblingGraphOwner[] {
  const out: SiblingGraphOwner[] = [];
  const push = (sessionId: string, state: OwnerLike | undefined, sessionName?: string, ownDir = true): void => {
    for (const slot of ["active", "parked"] as const) {
      const owner = state?.[slot];
      if (!owner || (owner.kind !== "graph" && owner.kind !== "swarm")) continue;
      // A sibling dir whose owner belongs to yet another session is skipped;
      // legacy owners keep their real session id (the note needs it).
      if (ownDir && owner.sessionId && owner.sessionId !== sessionId) continue;
      out.push({
        sessionId,
        kind: owner.kind === "swarm" ? "swarm" : "graph",
        label: owner.label ?? "",
        ...(sessionName !== undefined ? { sessionName } : {}),
        ...(owner.pid !== undefined ? { pid: owner.pid } : {}),
        updatedAt: state?.updatedAt ?? "",
      });
      break;
    }
  };
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ownSessionId) continue;
      const state = readOwnerState(join(sessionsDir, entry.name, "state.json"));
      // An owner stamped with OUR session id lives in our dir, not here.
      if (state?.active?.sessionId === ownSessionId || state?.parked?.sessionId === ownSessionId) continue;
      push(entry.name, state);
    }
  } catch {
    // No sessions dir yet: fall through to the legacy scan.
  }
  // Leftover legacy state (pre-split workspace-level AND the older in-repo
  // dir): warn the same way — the user should /resume the owning session.
  for (const legacyDir of legacyDirs) {
    if (!legacyDir) continue;
    const state = readOwnerState(join(legacyDir, "state.json"));
    if (state && state.active?.sessionId !== ownSessionId && state.parked?.sessionId !== ownSessionId) {
      push("(legacy)", state, undefined, false);
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** `process.kill(pid, 0)` — the stamped owner process is alive. */
export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The one-line ui.notify note for a sibling graph owner (most recent wins). */
export function graphOwnerNote(owner: SiblingGraphOwner | undefined): string | undefined {
  if (!owner) return undefined;
  const name = owner.sessionName ?? (owner.sessionId !== "(workspace)" ? owner.sessionId.slice(0, 12) : "another session");
  if (pidAlive(owner.pid)) {
    return `Agent ${owner.kind} "${owner.label}" is running in another session (${name}) — /resume it to follow it.`;
  }
  return `Agent ${owner.kind} "${owner.label}" is paused in another session (${name}) — /resume it to continue.`;
}

// ── history aggregate + read-only sibling results ────────────────────────────

/** A graph file: `{ v, history: [...], current?: graph }`. */
export interface GraphFile {
  history: Array<Record<string, unknown> & { graphId?: string; createdAt?: number }>;
  current?: Record<string, unknown> & { graphId?: string; createdAt?: number };
}

function readGraphFile(path: string): GraphFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readJsonFile(path)) as GraphFile;
    if (!parsed || !Array.isArray(parsed.history)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function graphUpdatedAt(graph: Record<string, unknown>): number {
  const at = graph.updatedAt ?? graph.createdAt;
  return typeof at === "number" ? at : 0;
}

function isClosed(graph: Record<string, unknown>): boolean {
  return !!(graph.finish || graph.abandoned);
}

/**
 * Earlier graphs across the project: the caller's own list plus siblings'
 * finished graphs (their `history` and a closed `current` — never another
 * session's OPEN graph). Deduped by graphId, newest first.
 */
export function aggregateGraphHistory(
  own: Array<Record<string, unknown> & { graphId?: string }>,
  sessionsDir: string,
  ownSessionId: string,
): Array<Record<string, unknown> & { graphId?: string }> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const graph of own) {
    const id = graph.graphId;
    if (typeof id === "string") byId.set(id, graph);
  }
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ownSessionId) continue;
      const file = readGraphFile(join(sessionsDir, entry.name, "graph.json"));
      if (!file) continue;
      for (const graph of file.history) {
        if (typeof graph.graphId === "string" && !byId.has(graph.graphId)) byId.set(graph.graphId, graph);
      }
      if (file.current && isClosed(file.current) && typeof file.current.graphId === "string" && !byId.has(file.current.graphId)) {
        byId.set(file.current.graphId, file.current);
      }
    }
  } catch {
    // No sessions dir: only the engine's own history.
  }
  return [...byId.values()].sort((a, b) => graphUpdatedAt(b) - graphUpdatedAt(a));
}

/**
 * Find a work item (by work id) inside a specific sibling graph (history or
 * closed current) — read-only, for the Progress sheet's Full result.
 */
export function findSiblingWork(
  sessionsDir: string,
  ownSessionId: string,
  graphId: string,
  workId: string,
): { work: Record<string, unknown>; graph: Record<string, unknown> } | undefined {
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ownSessionId) continue;
      const file = readGraphFile(join(sessionsDir, entry.name, "graph.json"));
      if (!file) continue;
      const candidates = [...file.history, ...(file.current && isClosed(file.current) ? [file.current] : [])];
      const graph = candidates.find((g) => g.graphId === graphId);
      if (!graph) continue;
      const work = (graph["work"] as Array<Record<string, unknown>> | undefined)?.find((w) => w.workId === workId);
      if (work) return { work, graph };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// ── housekeeping ─────────────────────────────────────────────────────────────

const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Remove sibling session dirs with no active/parked owner, no open graph and
 * mtime older than 30 days. Best-effort, never throws.
 */
export function pruneSiblingSessionDirs(sessionsDir: string, ownSessionId: string, now: number): string[] {
  const pruned: string[] = [];
  try {
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ownSessionId) continue;
      const dir = join(sessionsDir, entry.name);
      try {
        if (now - statSync(dir).mtimeMs <= PRUNE_AGE_MS) continue;
        const state = readOwnerState(join(dir, "state.json"));
        if (state?.active || state?.parked) continue;
        const file = readGraphFile(join(dir, "graph.json"));
        if (file?.current && !isClosed(file.current)) continue;
        rmSync(dir, { recursive: true, force: true });
        pruned.push(entry.name);
      } catch {
        // One bad dir never blocks the rest.
      }
    }
  } catch {
    // No sessions dir: nothing to prune.
  }
  return pruned;
}

/** The most recent mtime across a dir's own entries (best-effort). */
export function dirMtime(dir: string): number {
  try {
    return statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

/** Whether a session dir has any long-horizon state yet. */
export function sessionHasState(sessionDir: string): boolean {
  return existsSync(join(sessionDir, "state.json")) || existsSync(join(sessionDir, "goal.json")) || existsSync(join(sessionDir, "graph.json"));
}

export { existsSync };
