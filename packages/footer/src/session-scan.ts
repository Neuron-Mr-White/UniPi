/**
 * @pi-unipi/footer — Incremental session branch scan
 *
 * The old 1s tick replayed the WHOLE session branch every second. This module
 * remembers how many branch entries were already processed and feeds only new
 * ones into the TPS tracker; a full reset+rescan happens on branch change,
 * compaction (branch shrank or a compaction entry appears) and session_start.
 *
 * The trailing assistant message may still be in flight (no stopReason yet):
 * it is re-fed on every scan until it completes, mirroring the old full-replay
 * semantics. Completed records are immutable in the tracker, so re-feeds of
 * done messages are no-ops.
 *
 * The same pass accumulates the strip's data snapshot: usage sums (input /
 * output / cache / cost), the compaction summary and the user-turn count —
 * so renderSessionStrip never has to walk the branch per paint.
 */

import { tpsTracker } from "./tps-tracker.js";
import { compactionSummary } from "./segments/compactor.js";

/** Data the stats strip reads, accumulated during the scan. */
export interface SessionSnapshot {
  /** Branch entries seen (branch.length at last scan). */
  branchLength: number;
  /** User messages — the turn count floor. */
  userCount: number;
  /** Assistant messages fed to the tracker (error/aborted skipped). */
  assistantCount: number;
  /** Usage sums over the same assistant messages (pi-reported values). */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Compaction summary over the whole branch. */
  compactionCount: number;
  compactionBefore: number;
  compactionAfter: number;
  compactionLastAt?: number;
  /** Timestamp of the last kept assistant message (wall-time bound). */
  lastAssistantAt: number | null;
}

function emptySnapshot(): SessionSnapshot {
  return {
    branchLength: 0,
    userCount: 0,
    assistantCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    compactionCount: 0,
    compactionBefore: 0,
    compactionAfter: 0,
    lastAssistantAt: null,
  };
}

/** Numeric usage fields of an assistant message (zeroes when absent). */
function usageParts(usage: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cost = u.cost as Record<string, unknown> | undefined;
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    cost: num(cost?.total),
  };
}

export class SessionScanner {
  /** Entries already fed to the tracker / accumulators. */
  private processed = 0;

  /** Branch-derived tool time: pending callId → assistant msg ts. */
  private pendingToolCalls = new Map<string, number>();
  private branchToolMs = 0;

  /** Assistant timestamp bounds for the wall-time sync. */
  private firstAssistantTs = 0;
  private lastAssistantTs = 0;
  private prevAssistantTs = 0;

  /** Trailing in-flight assistant message (no stopReason) — re-fed per scan
   *  from the LIVE branch entry, so stream-end usage is picked up. */
  private inflightEntryIdx = -1;
  /** Tracker record index of that message. */
  private inflightMsgIndex = -1;
  /** Usage contribution of the in-flight message at first sighting —
   *  subtracted before the fresh (final) usage is added on completion. */
  private inflightUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  snapshot: SessionSnapshot = emptySnapshot();

  /** True when the branch shrank or a compaction entry appears in the tail. */
  needsFullRescan(events: readonly unknown[]): boolean {
    if (this.processed === 0) return true;
    if (events.length < this.processed) return true;
    for (let i = this.processed; i < events.length; i++) {
      const e = events[i] as { type?: string } | null | undefined;
      if (e?.type === "compaction") return true;
    }
    return false;
  }

  /** Forget all scan state. The caller resets the tracker separately. */
  reset(): void {
    this.processed = 0;
    this.pendingToolCalls.clear();
    this.branchToolMs = 0;
    this.firstAssistantTs = 0;
    this.lastAssistantTs = 0;
    this.prevAssistantTs = 0;
    this.inflightEntryIdx = -1;
    this.inflightMsgIndex = -1;
    this.inflightUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    this.snapshot = emptySnapshot();
  }

  /**
   * Feed unprocessed branch entries to the tracker and accumulators,
   * reconciling the trailing in-flight message first. Cheap to call every
   * tick: already-processed entries are never touched again.
   */
  scan(events: readonly unknown[]): void {
    // Reconcile the in-flight tail FIRST: the entry may have completed (final
    // usage, stopReason) or been replaced in place since the last tick.
    this.reconcileInflight(events);
    for (let i = this.processed; i < events.length; i++) {
      this.processEntry((events[i] as Record<string, unknown>) ?? {}, i);
    }
    this.processed = events.length;

    this.refreshCompactions(events);
    this.snapshot.branchLength = events.length;

    // Branch stat syncs are monotonic — cheap to re-assert every scan.
    tpsTracker.syncBranchStats(this.snapshot.userCount, this.snapshot.assistantCount);
    if (this.lastAssistantTs > this.firstAssistantTs) {
      tpsTracker.syncWallMs(this.lastAssistantTs - this.firstAssistantTs);
    }
    tpsTracker.syncToolMs(this.branchToolMs);
  }

  /**
   * Re-feed the trailing in-flight assistant message from its LIVE branch
   * entry until it has a stopReason. The tracker feed is idempotent for done
   * records; the snapshot usage sums swap the first-sighting contribution for
   * the fresh (final) values so stream-end usage is never missed.
   */
  private reconcileInflight(events: readonly unknown[]): void {
    if (this.inflightEntryIdx < 0) return;
    const live = events[this.inflightEntryIdx] as { message?: Record<string, unknown> } | undefined;
    const m = live?.message;
    if (!m) {
      this.inflightEntryIdx = -1;
      this.inflightMsgIndex = -1;
      return;
    }
    tpsTracker.onMessageUpdate(this.inflightMsgIndex, m, !!m.stopReason);

    // Swap the usage contribution (partial at first sighting → final now).
    this.snapshot.input -= this.inflightUsage.input;
    this.snapshot.output -= this.inflightUsage.output;
    this.snapshot.cacheRead -= this.inflightUsage.cacheRead;
    this.snapshot.cacheWrite -= this.inflightUsage.cacheWrite;
    this.snapshot.cost -= this.inflightUsage.cost;
    this.inflightUsage = usageParts(m.usage);
    this.snapshot.input += this.inflightUsage.input;
    this.snapshot.output += this.inflightUsage.output;
    this.snapshot.cacheRead += this.inflightUsage.cacheRead;
    this.snapshot.cacheWrite += this.inflightUsage.cacheWrite;
    this.snapshot.cost += this.inflightUsage.cost;
    if (m.stopReason) {
      this.inflightEntryIdx = -1;
      this.inflightMsgIndex = -1;
      this.inflightUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    }
  }

  /** Recompute the compaction summary over the whole branch (entries are few). */
  private refreshCompactions(events: readonly unknown[]): void {
    const cmp = compactionSummary(events as any[]);
    this.snapshot.compactionCount = cmp.count;
    this.snapshot.compactionBefore = cmp.before;
    this.snapshot.compactionAfter = cmp.after;
    this.snapshot.compactionLastAt = cmp.lastAt;
  }

  private processEntry(e: Record<string, unknown>, entryIdx: number): void {
    if (e.type !== "message") return;
    const m = e.message as Record<string, unknown> | undefined;
    if (!m) return;

    // Branch-derived turn/wall accounting: user messages delimit turns;
    // assistant timestamps bound the session wall time.
    const ts = Date.parse((e.timestamp as string) ?? "") || 0;
    if (m.role === "user") {
      this.snapshot.userCount++;
      return;
    }
    if (m.role === "toolResult") {
      // Pair back to the assistant that issued this call.
      const callId = m.toolCallId as string | undefined;
      if (callId && this.pendingToolCalls.has(callId)) {
        const issuedAt = this.pendingToolCalls.get(callId)!;
        this.pendingToolCalls.delete(callId);
        if (ts > issuedAt) this.branchToolMs += Math.min(ts - issuedAt, 600_000);
      }
      return;
    }
    if (m.role !== "assistant") return;
    if (m.stopReason === "error" || m.stopReason === "aborted") return;

    if (ts > 0) {
      if (this.firstAssistantTs === 0 || ts < this.firstAssistantTs) this.firstAssistantTs = ts;
      if (ts > this.lastAssistantTs) this.lastAssistantTs = ts;
    }

    const msgIndex = this.snapshot.assistantCount;
    const usage = usageParts(m.usage);
    this.snapshot.input += usage.input;
    this.snapshot.output += usage.output;
    this.snapshot.cacheRead += usage.cacheRead;
    this.snapshot.cacheWrite += usage.cacheWrite;
    this.snapshot.cost += usage.cost;

    const hasStop = !!m.stopReason;
    // Pass the whole message: completed messages get anchored to exact
    // provider usage.output; in-flight ones density-estimated.
    tpsTracker.onMessageUpdate(msgIndex, m, hasStop);
    // Register this message's tool calls for result pairing. Block type is
    // "toolCall" (capital C) in persisted sessions.
    const content = m.content as Array<{ type?: string; id?: string }> | undefined;
    if (Array.isArray(content)) {
      for (const block of content) {
        const btype = String(block?.type ?? "").toLowerCase();
        const callId = block?.id;
        if ((btype === "toolcall" || btype === "tool_use") && typeof callId === "string" && ts > 0) {
          this.pendingToolCalls.set(callId, ts);
        }
      }
    }
    // TTFT seed AFTER record creation: prev assistant ts ≈ request bound, own
    // ts ≈ first output. No-ops once hooks give samples.
    if (ts > 0) {
      tpsTracker.seedTtftFallback(this.prevAssistantTs, ts, msgIndex);
      this.prevAssistantTs = ts;
    }

    this.snapshot.assistantCount++;
    this.snapshot.lastAssistantAt = ts > 0 ? ts : this.snapshot.lastAssistantAt;
    if (hasStop) {
      this.inflightEntryIdx = -1;
      this.inflightMsgIndex = -1;
      this.inflightUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    } else {
      this.inflightEntryIdx = entryIdx;
      this.inflightMsgIndex = msgIndex;
      // Remember what this message contributed so completion can swap in the
      // final usage (reconcileInflight).
      this.inflightUsage = usage;
    }
  }
}
