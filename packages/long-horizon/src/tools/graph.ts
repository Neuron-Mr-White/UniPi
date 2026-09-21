/**
 * Graph (staged v1) — dependent fan-out with input frontiers.
 *
 * Maka's insight compressed to v1: work items may DEPEND on other items'
 * committed results; the ledger computes readiness, and each report hands
 * the model the next wave with source-linked inputs (dependency summaries),
 * never restated conclusions. Waves are topological levels computed at
 * declare time; cycles and unknown deps are refused up front.
 *
 * v1 scope (deliberate): single-graph-per-session, declare-once, reports via
 * graph_output, auto-close when every item is terminal. Full Maka semantics
 * (monotonic mid-flight topology, stop/replace, explicit finish with
 * selected record ids, durable child sessions) are v2 — this stage proves
 * the frontier mechanics over the same delegation tools swarm uses.
 *
 * Design: docs/long-horizon-design.md §4/§8; study §8.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OwnerCoordinator } from "../owner.js";

export type GraphItemStatus = "queued" | "ready" | "dispatched" | "completed" | "failed" | "aborted";

export interface GraphItem {
  readonly itemId: string;
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly wave: number;
  status: GraphItemStatus;
  attempts: number;
  summary?: string;
}

export interface GraphSnapshot {
  readonly graphId: string;
  readonly task: string;
  readonly waves: ReadonlyArray<ReadonlyArray<{ itemId: string; status: GraphItemStatus; wave: number }>>;
  readonly open: number;
  readonly settled: boolean;
}

export interface ReadyHandoff {
  readonly itemId: string;
  readonly instruction: string;
  /** Source-linked input frontier: dependency summaries, keyed by dep id. */
  readonly inputs: ReadonlyArray<{ from: string; summary: string }>;
}

export const GRAPH_ORCHESTRATION_PROMPT = `<long-horizon-graph>
Graph Mode is active. You are the supervisor of a dependent work graph.

- Declare the graph first with update_agent_graph: items with explicit dependsOn (an item's inputs are the COMMITTED results of its dependencies). Cycles are refused.
- Dispatch every currently-ready item with spawn_helper or bg_delegate. Do not dispatch an item before its dependencies complete.
- After dispatching a wave, call swarm_yield. Do not poll; background notifications wake you.
- On wake, record outcomes with graph_output. Recording a completion hands you the next ready items together with their input frontiers (the dependency summaries) — pass those inputs into the child instructions instead of restating conclusions.
- A failed item can be re-dispatched after its failure is recorded; downstream items stay blocked until it completes or is aborted.
- When every item is terminal, the graph closes automatically: deduplicate, verify, and synthesize for the user.
</long-horizon-graph>`;

export interface DeclareItem {
  readonly itemId: string;
  readonly instruction: string;
  readonly dependsOn?: readonly string[];
}

export class GraphLedger {
  private graphId: string | null = null;
  private task = "";
  private items: GraphItem[] = [];

  constructor(private readonly owner: OwnerCoordinator) {}

  get(): GraphSnapshot | null {
    if (this.graphId === null) return null;
    return this.snapshot();
  }

  /**
   * Declare the graph: validates deps (known ids, no cycles), computes
   * topological waves, marks roots ready, activates the graph owner.
   */
  declare(task: string, declared: readonly DeclareItem[]):
    | { ok: true; roots: ReadyHandoff[] }
    | { ok: false; reason: string } {
    if (this.graphId !== null && this.items.some((item) => item.status !== "completed" && item.status !== "failed" && item.status !== "aborted")) {
      return { ok: false, reason: `graph "${this.task}" still has open items — finish it first` };
    }
    if (this.owner.getActive()) {
      return { ok: false, reason: `session is owned by a ${this.owner.getActive()?.kind} owner — finish or suspend it first` };
    }
    if (declared.length === 0) {
      return { ok: false, reason: "a graph needs at least one item" };
    }
    const byId = new Map(declared.map((item) => [item.itemId, item]));
    if (byId.size !== declared.length) {
      return { ok: false, reason: "duplicate item ids" };
    }
    for (const item of declared) {
      for (const dep of item.dependsOn ?? []) {
        if (!byId.has(dep)) return { ok: false, reason: `${item.itemId} depends on unknown item ${dep}` };
        if (dep === item.itemId) return { ok: false, reason: `${item.itemId} depends on itself` };
      }
    }
    // Cycle check + wave computation (DFS memo).
    const waves = new Map<string, number>();
    const visiting = new Set<string>();
    const waveOf = (id: string): number => {
      const memo = waves.get(id);
      if (memo !== undefined) return memo;
      if (visiting.has(id)) throw new Error(`cycle through ${id}`);
      visiting.add(id);
      const deps = byId.get(id)?.dependsOn ?? [];
      const wave = deps.length === 0 ? 0 : Math.max(...deps.map(waveOf)) + 1;
      visiting.delete(id);
      waves.set(id, wave);
      return wave;
    };
    try {
      for (const item of declared) waveOf(item.itemId);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "cycle detected" };
    }

    this.graphId = `graph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.task = task;
    this.items = declared.map((item) => ({
      itemId: item.itemId,
      instruction: item.instruction,
      dependsOn: item.dependsOn ?? [],
      wave: waves.get(item.itemId) ?? 0,
      status: (item.dependsOn ?? []).length === 0 ? "ready" : "queued",
      attempts: 0,
    }));
    this.owner.activate("graph", task);
    return { ok: true, roots: this.readyHandoffs() };
  }

  /** Mark a ready item dispatched (roots only until deps complete). */
  markDispatched(itemId: string): { ok: true } | { ok: false; reason: string } {
    const item = this.find(itemId);
    if (!item) return { ok: false, reason: `unknown item ${itemId}` };
    if (item.status !== "ready" && item.status !== "failed") {
      return { ok: false, reason: `${itemId} is ${item.status} — only ready items dispatch` };
    }
    item.status = "dispatched";
    item.attempts += 1;
    return { ok: true };
  }

  /**
   * Record an outcome; returns the newly ready items with their input
   * frontiers. Auto-closes the owner when everything is terminal.
   */
  report(itemId: string, status: "completed" | "failed" | "aborted", summary?: string):
    | { ok: true; newlyReady: ReadyHandoff[]; settled: boolean }
    | { ok: false; reason: string } {
    const item = this.find(itemId);
    if (!item) return { ok: false, reason: `unknown item ${itemId}` };
    if (item.status === "completed" || item.status === "aborted") {
      return { ok: false, reason: `${itemId} already ${item.status}` };
    }
    item.status = status;
    if (summary !== undefined) item.summary = summary.slice(0, 400);
    if (status === "failed") {
      return { ok: true, newlyReady: [], settled: false }; // blocked until replaced or aborted
    }
    // Promote queued items whose deps are all completed.
    const newlyReady: ReadyHandoff[] = [];
    for (const candidate of this.items) {
      if (candidate.status !== "queued") continue;
      const deps = candidate.dependsOn.map((dep) => this.find(dep));
      if (deps.every((dep) => dep?.status === "completed")) {
        candidate.status = "ready";
        newlyReady.push(this.handoff(candidate));
      }
    }
    const settled = this.items.every(
      (entry) => entry.status === "completed" || entry.status === "failed" || entry.status === "aborted",
    );
    if (settled) {
      const anyFailure = this.items.some((entry) => entry.status === "failed" || entry.status === "aborted");
      this.owner.finish(anyFailure ? "settled(with_failures)" : "settled");
    }
    return { ok: true, newlyReady, settled };
  }

  /** Abort propagates: an aborted item's blocked descendants become aborted too. */
  abort(itemId: string): { ok: true; aborted: string[] } | { ok: false; reason: string } {
    const item = this.find(itemId);
    if (!item) return { ok: false, reason: `unknown item ${itemId}` };
    const aborted: string[] = [];
    const cascade = (id: string) => {
      const target = this.find(id);
      if (!target || target.status === "completed" || target.status === "aborted") return;
      target.status = "aborted";
      aborted.push(id);
      for (const entry of this.items) {
        if (entry.dependsOn.includes(id)) cascade(entry.itemId);
      }
    };
    cascade(itemId);
    const settled = this.items.every(
      (entry) => entry.status === "completed" || entry.status === "failed" || entry.status === "aborted",
    );
    if (settled) this.owner.finish("settled(with_failures)");
    return { ok: true, aborted };
  }

  snapshot(): GraphSnapshot {
    const byWave = new Map<number, Array<{ itemId: string; status: GraphItemStatus; wave: number }>>();
    for (const item of this.items) {
      const list = byWave.get(item.wave) ?? [];
      list.push({ itemId: item.itemId, status: item.status, wave: item.wave });
      byWave.set(item.wave, list);
    }
    const waves = [...byWave.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, list]) => list.sort((a, b) => a.itemId.localeCompare(b.itemId)));
    const open = this.items.filter((item) => item.status !== "completed" && item.status !== "failed" && item.status !== "aborted").length;
    return {
      graphId: this.graphId!,
      task: this.task,
      waves,
      open,
      settled: open === 0 && this.items.length > 0,
    };
  }

  readyHandoffs(): ReadyHandoff[] {
    return this.items.filter((item) => item.status === "ready").map((item) => this.handoff(item));
  }

  private handoff(item: GraphItem): ReadyHandoff {
    return {
      itemId: item.itemId,
      instruction: item.instruction,
      inputs: item.dependsOn.map((dep) => ({
        from: dep,
        summary: this.find(dep)?.summary ?? "(no summary recorded)",
      })),
    };
  }

  private find(itemId: string): GraphItem | undefined {
    return this.items.find((item) => item.itemId === itemId);
  }
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

export interface GraphToolDeps {
  readonly ledger: GraphLedger;
}

export function registerGraphTools(pi: ExtensionAPI, deps: GraphToolDeps): void {
  pi.registerTool({
    name: "update_agent_graph",
    label: "Update Agent Graph",
    description:
      "Declare the work graph ONCE: items with dependsOn frontiers. Roots become ready immediately " +
      "(returned as handoffs). Cycles, self-deps, and unknown deps are refused.",
    parameters: Type.Object({
      task: Type.String({ description: "One-line description of the overall graph task." }),
      items: Type.Array(
        Type.Object({
          item_id: Type.String({ description: "Stable item id (referenced by dependsOn)." }),
          instruction: Type.String({ description: "Bounded, self-contained instruction for the item." }),
          depends_on: Type.Optional(Type.Array(Type.String(), { description: "Item ids whose committed results this item consumes." })),
        }),
        { minItems: 1 },
      ),
    }),
    execute: async (_id, params) => {
      const { task, items } = params as { task: string; items: Array<{ item_id: string; instruction: string; depends_on?: string[] }> };
      const declared = deps.ledger.declare(
        task,
        items.map((item) => ({
          itemId: item.item_id,
          instruction: item.instruction,
          ...(item.depends_on ? { dependsOn: item.depends_on } : {}),
        })),
      );
      if (!declared.ok) return textResult(declared.reason);
      return textResult(
        `Graph declared (${deps.ledger.snapshot().waves.length} waves). Ready now — dispatch each once, then swarm_yield:\n` +
          declared.roots.map((root) => `- ${root.itemId}: ${root.instruction}`).join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "graph_output",
    label: "Graph Output",
    description:
      "Record an item outcome. A completion returns the newly ready items WITH their input frontiers " +
      "(dependency summaries) — pass those into the child instructions. A failure blocks dependents " +
      "until the item is re-dispatched and completes, or aborted.",
    parameters: Type.Object({
      item_id: Type.String(),
      status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("aborted")]),
      summary: Type.Optional(Type.String({ description: "The committed result (≤400 chars) — downstream items receive it verbatim." })),
      dispatched: Type.Optional(Type.Boolean({ description: "Mark dispatched (first call before results arrive)." })),
    }),
    execute: async (_id, params) => {
      const { item_id, status, summary, dispatched } = params as {
        item_id: string;
        status: "completed" | "failed" | "aborted";
        summary?: string;
        dispatched?: boolean;
      };
      if (dispatched && status !== "aborted") {
        const marked = deps.ledger.markDispatched(item_id);
        if (!marked.ok) return textResult(marked.reason);
      }
      if (status === "aborted") {
        const aborted = deps.ledger.abort(item_id);
        if (!aborted.ok) return textResult(aborted.reason);
        return textResult(`Aborted: ${aborted.aborted.join(", ")}.`);
      }
      const reported = deps.ledger.report(item_id, status, summary);
      if (!reported.ok) return textResult(reported.reason);
      if (reported.settled) {
        return textResult("Graph settled — all items terminal. Deduplicate, verify, and synthesize for the user now.");
      }
      if (reported.newlyReady.length === 0) {
        return textResult(`Recorded ${item_id} → ${status}. No new items ready.`);
      }
      return textResult(
        `Recorded ${item_id} → ${status}. Newly ready (dispatch with these input frontiers, then swarm_yield):\n` +
          reported.newlyReady
            .map((handoff) =>
              `- ${handoff.itemId}: ${handoff.instruction}` +
              (handoff.inputs.length > 0
                ? `\n  inputs: ${handoff.inputs.map((input) => `[${input.from}] ${input.summary}`).join(" | ")}`
                : ""),
            )
            .join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "view_agent_graph",
    label: "View Agent Graph",
    description: "Snapshot: waves, per-item status, open count, settled flag.",
    parameters: Type.Object({}),
    execute: async () => {
      const snapshot = deps.ledger.get();
      if (!snapshot) return textResult("No graph is active.");
      return textResult(JSON.stringify(snapshot, null, 2));
    },
  });
}
