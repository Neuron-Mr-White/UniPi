/**
 * Swarm — Maka's fan-out prescription over unipi's delegation tools.
 *
 * The ledger is the durable schedule: declared items with reported outcomes.
 * The MODEL dispatches via spawn_helper/bg_delegate (full surface in swarm
 * mode); swarm_report records outcomes idempotently; swarm_status projects
 * running | needs_attention | settled; swarm_yield ends the supervisor turn
 * (wakes arrive via background-task notifications — user-first by design).
 *
 * v1 seam honesty: spawn_helper dispatch is opaque to extensions, so
 * claim-before-dispatch is enforced by the orchestration prompt (one dispatch
 * per item) plus report idempotency (duplicate terminal reports refused
 * unless the item was failed and is being replaced). Harness-level claims
 * arrive with graph mode (v2).
 *
 * Design: docs/long-horizon-design.md §4/§8; study §8.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwnerCoordinator } from "../owner.js";

export type SwarmItemStatus = "queued" | "dispatched" | "completed" | "failed" | "aborted";

export interface SwarmItem {
  readonly itemId: string;
  readonly instruction: string;
  status: SwarmItemStatus;
  attempts: number;
  summary?: string;
}

export type SwarmStatusKind = "running" | "needs_attention" | "settled";

export interface SwarmSnapshot {
  readonly swarmId: string;
  readonly task: string;
  readonly status: SwarmStatusKind;
  readonly counts: Record<SwarmItemStatus, number>;
  readonly items: readonly SwarmItem[];
}

export const SWARM_ORCHESTRATION_PROMPT = `<long-horizon-swarm>
Swarm Mode is active. Treat parallel delegation as the preferred execution strategy for this request.

- Before acting, decide whether parallel delegation would materially improve speed, quality, coverage, or independent verification. If the work cannot be usefully divided into at least two meaningful independent items, continue directly.
- Make every item bounded and self-contained: explicit scope, expected output, constraints. Avoid overlapping writes; prefer read-only investigation.
- Dispatch each item exactly once with spawn_helper or bg_delegate (run_in_background). Do not re-dispatch an item unless you reported it failed and are replacing it.
- After dispatching all items, call swarm_yield. Do not poll, sleep, watch task logs, or wait synchronously; background-task notifications will wake you when work settles.
- On wake, call swarm_status for compact statuses. Read full results only for completed items you will synthesize or failed items you must diagnose.
- Record every outcome with swarm_report. Replace failed work by re-dispatching a corrected item and reporting it under the same id.
- When all useful work is settled, deduplicate, verify, and semantically synthesize the results for the user.
- Do not manufacture parallelism or create duplicate busywork merely because Swarm Mode is enabled.
</long-horizon-swarm>`;

export class SwarmLedger {
  private swarmId: string | null = null;
  private task = "";
  private items: SwarmItem[] = [];

  constructor(private readonly owner: OwnerCoordinator) {}

  get(): SwarmSnapshot | null {
    if (this.swarmId === null) return null;
    return this.snapshot();
  }

  start(task: string, items: Array<{ itemId: string; instruction: string }>):
    { ok: true; snapshot: SwarmSnapshot } | { ok: false; reason: string } {
    if (this.owner.getActive() && this.items.some((item) => item.status === "dispatched" || item.status === "queued")) {
      const active = this.owner.getActive();
      if (active && active.kind === "swarm" && this.swarmId !== null && this.items.length > 0) {
        return { ok: false, reason: `swarm "${this.task}" is already active — report or finish it first` };
      }
      return { ok: false, reason: `session is owned by a ${active?.kind} owner — finish or suspend it first` };
    }
    if (items.length < 2) {
      return { ok: false, reason: "a swarm needs at least two independent items (otherwise work directly)" };
    }
    this.swarmId = `swarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.task = task;
    this.items = items.map((item) => ({ ...item, status: "queued", attempts: 0 }));
    this.owner.activate("swarm", task);
    return { ok: true, snapshot: this.snapshot() };
  }

  /** Mark dispatched (idempotent: queued → dispatched; re-dispatch only after failure). */
  markDispatched(itemId: string): { ok: true } | { ok: false; reason: string } {
    const item = this.find(itemId);
    if (!item) return { ok: false, reason: `unknown item ${itemId}` };
    if (item.status === "dispatched") return { ok: false, reason: `${itemId} already dispatched — do not re-dispatch` };
    if (item.status === "completed" || item.status === "aborted") {
      return { ok: false, reason: `${itemId} is ${item.status} — nothing to dispatch` };
    }
    item.status = "dispatched";
    item.attempts += 1;
    return { ok: true };
  }

  /** Record an outcome. Re-reporting the same terminal state is idempotent-noop info. */
  report(itemId: string, status: "completed" | "failed" | "aborted", summary?: string):
    { ok: true; settled: boolean } | { ok: false; reason: string } {
    const item = this.find(itemId);
    if (!item) return { ok: false, reason: `unknown item ${itemId}` };
    if (item.status === "completed" || item.status === "aborted") {
      return { ok: false, reason: `${itemId} already ${item.status} (${item.summary ?? "no summary"})` };
    }
    item.status = status;
    if (summary !== undefined) item.summary = summary.slice(0, 400);
    return { ok: true, settled: this.settled() };
  }

  settled(): boolean {
    return this.items.length > 0 && this.items.every((item) => item.status === "completed" || item.status === "failed" || item.status === "aborted");
  }

  snapshot(): SwarmSnapshot {
    const counts: Record<SwarmItemStatus, number> = {
      queued: 0,
      dispatched: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
    };
    for (const item of this.items) counts[item.status] += 1;
    const attention = counts.failed > 0 || counts.aborted > 0;
    const open = counts.queued + counts.dispatched;
    const status: SwarmStatusKind = open > 0 ? (attention ? "needs_attention" : "running") : attention ? "needs_attention" : "settled";
    return { swarmId: this.swarmId!, task: this.task, status, counts, items: this.items.map((item) => ({ ...item })) };
  }

  private find(itemId: string): SwarmItem | undefined {
    return this.items.find((item) => item.itemId === itemId);
  }
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

export interface SwarmToolDeps {
  readonly ledger: SwarmLedger;
  readonly owner: OwnerCoordinator;
}

export function registerSwarmTools(pi: ExtensionAPI, deps: SwarmToolDeps): void {
  pi.registerTool({
    name: "swarm_report",
    label: "Swarm Report",
    description:
      "Record a swarm item outcome. completed/failed/aborted. Re-reporting a terminal item is refused; " +
      "a failed item may be re-dispatched and reported again. When the last item settles, finish the " +
      "owner and synthesize.",
    parameters: Type.Object({
      item_id: Type.String({ description: "The item id from the plan" }),
      status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")]),
      summary: Type.Optional(Type.String({ description: "One sentence outcome (≤400 chars)." })),
      dispatched: Type.Optional(Type.Boolean({ description: "Mark dispatched (first report before results arrive)." })),
    }),
    execute: async (_id, params) => {
      const { item_id, status, summary, dispatched } = params as {
        item_id: string;
        status: "completed" | "failed" | "aborted";
        summary?: string;
        dispatched?: boolean;
      };
      if (dispatched) {
        const marked = deps.ledger.markDispatched(item_id);
        if (!marked.ok) return textResult(marked.reason);
      }
      const reported = deps.ledger.report(item_id, status, summary);
      if (!reported.ok) return textResult(reported.reason);
      if (reported.settled) {
        const snapshot = deps.ledger.snapshot();
        deps.owner.finish(snapshot.counts.failed + snapshot.counts.aborted > 0 ? "settled(with_failures)" : "settled");
        return textResult(
          "All items settled — swarm closed. Deduplicate, verify, and synthesize the results for the user now.",
        );
      }
      return textResult(`Recorded ${item_id} → ${status}.`);
    },
  });

  pi.registerTool({
    name: "swarm_status",
    label: "Swarm Status",
    description: "Compact swarm projection: statuses, counts, per-item state.",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = deps.ledger.get();
      if (!snapshot) return textResult("No swarm is active.");
      return textResult(JSON.stringify(snapshot, null, 2));
    },
  });

  pi.registerTool({
    name: "swarm_yield",
    label: "Swarm Yield",
    description:
      "End the supervisor turn after scheduling. Background-task notifications wake you when work " +
      "settles; do not poll or sleep while items execute.",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = deps.ledger.get();
      if (!snapshot) return textResult("No swarm is active.");
      return textResult(
        "Yield acknowledged. End this turn now; dispatched work will wake you via its completion notification. " +
          "On wake: swarm_status first, then read completed results or replace failed work.",
      );
    },
  });
}
