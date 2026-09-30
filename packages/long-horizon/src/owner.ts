/**
 * Automation-owner coordinator — ONE active owner per session, max ONE parked.
 *
 * Design: docs/long-horizon-design.md §3. Owners are continuation machines
 * (goal | ralph-loop | swarm | graph). Control leases make stale tool calls
 * from pre-suspend turns reject; revision checkpoints make stale settlements
 * silently drop. State persists to .unipi/long-horizon/state.json on every
 * transition so crash recovery is a reload, not a replay.
 *
 * mcode: "Session already has an active Cron or AgentTeam automation owner" —
 * one automation owner per session is a hard rule, not a preference.
 */

import { randomUUID } from "node:crypto";
import { ensureDir, isChildProcess, markSharedOwnerStopped, setSharedOwner, tryRead, writeJson } from "@pi-unipi/core";
import type { OwnerKind } from "./modes.js";

/** Surfaced by create_goal / ralph / swarm / graph tools inside children. */
export const CHILD_OWNER_REFUSAL =
  "Long-horizon owners are not available inside a child agent — do the work and report back to the lead.";

export type OwnerStatus = "active" | "parked";

export interface OwnerLease {
  readonly ownerId: string;
  readonly generation: number;
}

export interface OwnerState {
  readonly ownerId: string;
  readonly kind: OwnerKind;
  /** Human label (goal condition, loop name, swarm task). */
  readonly label: string;
  readonly status: OwnerStatus;
  /** Why the current status holds, e.g. `paused(superseded_by:swarm)`. */
  readonly reason?: string;
  readonly revision: number;
  readonly lease: OwnerLease;
  readonly updatedAt: string;
}

export interface OwnerHistoryEntry {
  readonly ownerId: string;
  readonly kind: OwnerKind;
  readonly label: string;
  /** Terminal reason, e.g. `complete(verifier_met)`, `stalled`. */
  readonly terminalReason: string;
  readonly endedAt: string;
}

export interface OwnerSnapshot {
  readonly active?: OwnerState;
  readonly parked?: OwnerState;
  readonly history: readonly OwnerHistoryEntry[];
}

export interface OwnerCoordinatorDeps {
  /** Absolute path of the state file (usually under .unipi/long-horizon/). */
  statePath(): string;
  now?(): number;
  /** Best-effort observer; failures never roll back a committed transition. */
  onChange?(snapshot: OwnerSnapshot, event: OwnerEvent): void;
}

export type OwnerEvent =
  | { type: "activated"; owner: OwnerState }
  | { type: "suspended"; owner: OwnerState }
  | { type: "resumed"; owner: OwnerState }
  | { type: "finished"; owner: OwnerState; reason: string }
  | { type: "cleared"; owner: OwnerState }
  | { type: "restored"; snapshot: OwnerSnapshot };

const HISTORY_LIMIT = 10;

export class OwnerCoordinator {
  private active?: OwnerState;
  private parked?: OwnerState;
  private history: OwnerHistoryEntry[] = [];
  private readonly deps: OwnerCoordinatorDeps;

  constructor(deps: OwnerCoordinatorDeps) {
    this.deps = deps;
  }

  // ── Reads ────────────────────────────────────────────────────────────

  snapshot(): OwnerSnapshot {
    return {
      ...(this.active ? { active: this.active } : {}),
      ...(this.parked ? { parked: this.parked } : {}),
      history: [...this.history],
    };
  }

  getActive(): OwnerState | undefined {
    return this.active;
  }

  getParked(): OwnerState | undefined {
    return this.parked;
  }

  /** A lease is current if it names the active owner at its generation. */
  matchesActiveLease(ownerId: string, lease: OwnerLease): boolean {
    return (
      this.active?.ownerId === ownerId &&
      this.active.lease.ownerId === lease.ownerId &&
      this.active.lease.generation === lease.generation
    );
  }

  // ── Transitions ──────────────────────────────────────────────────────

  /**
   * Create and activate a new owner. Refuses while another owner is active —
   * callers surface "finish or suspend the current owner first". In child
   * processes owning is refused outright (throw — tool failures must throw).
   */
  activate(kind: OwnerKind, label: string): OwnerState | undefined {
    if (isChildProcess() && process.env.UNIPI_LH_ALLOW_CHILD !== "1") {
      throw new Error(CHILD_OWNER_REFUSAL);
    }
    if (this.active) return undefined;
    const ownerId = randomUUID();
    const now = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const owner: OwnerState = Object.freeze({
      ownerId,
      kind,
      label,
      status: "active",
      revision: 0,
      lease: Object.freeze({ ownerId, generation: 0 }),
      updatedAt: now,
    });
    this.active = owner;
    return this.commit({ type: "activated", owner });
  }

  /**
   * Park the active owner (suspend-and-switch). Refuses when the single park
   * slot is already held — the caller must surface resume-or-clear.
   */
  suspend(reason: string): OwnerState | undefined {
    if (!this.active || this.parked) return undefined;
    const suspended = this.commitActive({
      status: "parked",
      reason,
      lease: renewLease(this.active),
    });
    this.parked = suspended;
    this.active = undefined;
    return this.commit({ type: "suspended", owner: suspended });
  }

  /** Reactivate the parked owner. Refuses while any owner is active. */
  resume(): OwnerState | undefined {
    if (this.active || !this.parked) return undefined;
    const resumed = this.withOwner(this.parked, {
      status: "active",
      reason: undefined,
      lease: renewLease(this.parked),
    });
    this.active = resumed;
    this.parked = undefined;
    return this.commit({ type: "resumed", owner: resumed });
  }

  /** Move the active owner to history with a terminal reason. */
  finish(reason: string): OwnerState | undefined {
    if (!this.active) return undefined;
    const owner = this.active;
    this.active = undefined;
    this.history = [
      {
        ownerId: owner.ownerId,
        kind: owner.kind,
        label: owner.label,
        terminalReason: reason,
        endedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      },
      ...this.history,
    ].slice(0, HISTORY_LIMIT);
    return this.commit({ type: "finished", owner, reason });
  }

  /** Clear the parked owner (explicit user action). */
  clearParked(): OwnerState | undefined {
    if (!this.parked) return undefined;
    const owner = this.parked;
    this.parked = undefined;
    return this.commit({ type: "cleared", owner });
  }

  /**
   * Bump the revision on the active owner and return the new state. Used by
   * settlements; callers pair the returned revision into their checkpoints.
   */
  advanceRevision(): OwnerState | undefined {
    if (!this.active) return undefined;
    const advanced = this.withOwner(this.active, {
      revision: this.active.revision + 1,
    });
    this.active = advanced;
    this.persist();
    return advanced;
  }

  // ── Persistence ──────────────────────────────────────────────────────

  /** Load state from disk. Returns what was restored. Crash recovery = this. */
  restore(): OwnerSnapshot {
    const raw = tryRead(this.deps.statePath());
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as OwnerSnapshot & { version?: number };
        if (parsed && (!parsed.version || parsed.version === 1)) {
          this.active = parsed.active;
          this.parked = parsed.parked;
          this.history = [...(parsed.history ?? [])];
        }
      } catch {
        // Corrupt state is treated as absent: repair, don't resurrect.
      }
    }
    const snapshot = this.snapshot();
    this.deps.onChange?.(snapshot, { type: "restored", snapshot });
    this.publishStatus({ type: "restored", snapshot });
    return snapshot;
  }

  private commit(event: OwnerEvent): OwnerState | undefined {
    this.persist();
    this.publishStatus(event);
    this.deps.onChange?.(this.snapshot(), event);
    return "owner" in event ? event.owner : undefined;
  }

  /** Publish the transition to the shared holder kanboard's monitor reads. */
  private publishStatus(event: OwnerEvent): void {
    try {
      if (event.type === "finished") markSharedOwnerStopped(stopKindOf(event.reason));
      // Parked (paused) goals go through suspend, not finish — kanboard must
      // see them as a stop of kind "paused" this run, same as finish would.
      if (event.type === "suspended") markSharedOwnerStopped("paused");
      if (this.active) setSharedOwner({ kind: this.active.kind, status: "active" });
      else if (this.parked) setSharedOwner({ kind: this.parked.kind, status: "parked" });
      else setSharedOwner(undefined);
    } catch {
      // Status publishing must never roll back a committed transition.
    }
  }

  private commitActive(patch: Partial<OwnerState>): OwnerState {
    if (!this.active) throw new Error("commitActive without an active owner");
    const next = this.withOwner(this.active, patch);
    this.active = next;
    return next;
  }

  private withOwner(owner: OwnerState, patch: Partial<OwnerState>): OwnerState {
    return Object.freeze({
      ...owner,
      ...patch,
      updatedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
    });
  }

  private persist(): void {
    const path = this.deps.statePath();
    ensureDir(path);
    writeJson(path, { version: 1, ...this.snapshot() });
  }
}

function renewLease(owner: OwnerState): OwnerLease {
  return Object.freeze({
    ownerId: owner.ownerId,
    generation: owner.lease.generation + 1,
  });
}

/** Map a terminal reason to the coarse stop kind kanboard's monitor needs. */
export function stopKindOf(reason: string): "complete" | "paused" | "budget" | "other" {
  if (reason === "complete" || reason.startsWith("complete(")) return "complete";
  if (reason === "paused" || reason.startsWith("paused(")) return "paused";
  if (reason.includes("budget")) return "budget";
  return "other";
}
