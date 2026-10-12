/**
 * Agent Graph tools (UNI-279/280/281) — Maka's supervisor surface over the
 * durable GraphEngine (../graph/engine.ts):
 *
 *   update_agent_graph  add_work | stop | finish (schedule intent, durable)
 *   view_agent_graph    the durable graph: work, operators, results, history
 *   yield_agent_graph   end this supervisor turn; the host wakes you at the next checkpoint
 *   agent_output        read a committed result (or a failure / partial output)
 *   agent_swarm_status  compact swarm projection (swarm mode)
 *
 * The framework runs the work (subagents); the model never dispatches graph
 * work by hand. Prompts follow Maka's renderGraphModePrompt /
 * renderSwarmModePrompt, adapted to these tool names.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  countStatuses,
  DEFAULT_PROFILE,
  MAX_ADD_WORK,
  MAX_INPUT_IDS,
  MAX_RESULT_IDS,
  MAX_STOP,
  type AddWorkInput,
  type GraphEngine,
  type GraphMode,
  type GraphState,
  type GraphWork,
  type WorkViewStatus,
} from "../graph/engine.js";

export const GRAPH_ORCHESTRATION_PROMPT = `<orchestration_mode>
# Orchestration Mode: Graph
Graph Mode is active for this session. You are the main-agent supervisor beside the data path.
- Use update_agent_graph to schedule bounded work onto child subagents when a graph materially improves the task. The host runs the work; do not call run_subagent for graph work.
- Each add_work item needs a self-contained instruction (the child does not see this conversation). Give items a short work_id so later work can name them.
- Dependencies are input_ids: work ids (or result ids r-<work_id>) of this graph whose committed results the item consumes. Work waits until its inputs complete; the host attaches bounded upstream handoffs, so do not restate upstream conclusions in the instruction. You may declare the whole DAG in one update.
- Use view_agent_graph to observe work status, operators, waits, failures and committed result ids.
- After scheduling, call yield_agent_graph instead of polling, sleeping, or writing a waiting message. Yield ends only the current supervisor turn; the host wakes you at the next durable checkpoint (failure, nothing runnable, or everything settled) and the graph stays open.
- Keep topology changes monotonic: add work, stop obsolete work (stop), or replace failed work (replaces=<failed work id>). Do not assume edge deletion, rewiring, or cycles.
- For follow-up work on an existing child, set operator_id (from view_agent_graph); it resumes that child's session with its context.
- To build on a finished earlier graph, use selected_result_inputs with source_graph_id and result_id from view_agent_graph history.
- Before finishing, read the committed results you rely on with agent_output. A scheduling update must omit finish; send finish (result_ids + reason) in a later update once those results are committed, then synthesize them for the user.
- Stay available to the user across supervisor turns and explain material supervision decisions.
- You may continue directly when the request is small or a graph would add ceremony without useful decomposition.
</orchestration_mode>`;

export const SWARM_ORCHESTRATION_PROMPT = `<orchestration_mode>
# Orchestration Mode: Swarm
Swarm Mode is active for this session. Treat the durable asynchronous agent graph as the preferred execution strategy for each new user request.
- Before acting, decide whether parallel delegation would materially improve speed, quality, coverage, or independent verification.
- Prefer an asynchronous swarm when the work can be split into at least two meaningful independent items, including complementary execution and verification roles.
- You may continue directly when the request is small, conversational, latency-sensitive, or cannot be usefully divided.
- Perform only the lightweight exploration needed to establish boundaries before dispatch.
- Make every item bounded and self-contained with an explicit scope, expected output, and constraints.
- Avoid overlapping writes. Prefer read-only investigation (profile subagent_explore) unless isolated workspaces are available.
- Schedule all independent items together with one update_agent_graph add_work (pick each item's profile). The host runs them; do not call run_subagent for swarm items.
- After scheduling, call yield_agent_graph. Do not poll, sleep, watch child logs, or wait synchronously; the host will wake you only when work needs attention or the whole swarm is settled.
- On wake, call agent_swarm_status for compact statuses only. Read agent_output only for completed final results or narrow failed-item diagnosis.
- Replace failed work with update_agent_graph using replaces=<failed work id> so the failed item no longer keeps the swarm in needs_attention. When all useful work is settled, finish the graph (operation=finish, result_ids, reason), deduplicate, verify, and semantically synthesize the results.
- Do not manufacture parallelism or create duplicate busywork merely because Swarm Mode is enabled.
</orchestration_mode>`;

const VIEW_MAX_INSTRUCTION = 600;
const VIEW_MAX_TERMINAL = 64;
const OUTPUT_DEFAULT_BYTES = 32 * 1024;
const OUTPUT_MAX_BYTES = 128 * 1024;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean; terminate?: boolean };

function textResult(text: string, details?: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface GraphToolDeps {
  readonly engine: GraphEngine;
  /** The graph's mode for a new graph (the resolved long-horizon mode). */
  readonly mode: () => GraphMode;
  /** Profiles the runner can start (for validation + the schema hint). */
  readonly profiles: () => string[];
}

/** Compact, model-facing view of one graph. */
export function graphView(engine: GraphEngine, graph: GraphState, options: { history?: boolean } = {}): Record<string, unknown> {
  const status = (work: GraphWork) => engine.viewStatus(graph, work);
  const live = graph.work.filter((work) => work.status === "queued" || work.status === "running");
  const terminal = graph.work.filter((work) => work.status !== "queued" && work.status !== "running");
  const shown = [...live, ...terminal.slice(-VIEW_MAX_TERMINAL)];
  return {
    graph_id: graph.graphId,
    mode: graph.mode,
    task: graph.task,
    revision: graph.revision,
    state: graph.finish ? "finished" : graph.abandoned ? "stopped" : "open",
    counts: countStatuses(graph, status),
    work: shown.map((work) => ({
      work_id: work.workId,
      status: status(work),
      ...(work.status === "queued" && status(work) === "queued" && work.inputIds.length > 0 ? { waiting_for: work.inputIds.filter((id) => engine.findWork(id, graph)?.status !== "completed") } : {}),
      instruction: clip(work.instruction, VIEW_MAX_INSTRUCTION),
      profile: work.target.kind === "new_preset" ? work.target.subagentId : undefined,
      input_ids: work.inputIds,
      ...(work.selectedResultInputs.length > 0 ? { selected_result_inputs: work.selectedResultInputs.map((s) => ({ source_graph_id: s.sourceGraphId, result_id: s.resultId })) } : {}),
      ...(work.operatorId ? { operator_id: work.operatorId } : {}),
      ...(work.resultId ? { result_id: work.resultId } : {}),
      ...(work.failure ? { failure: clip(work.failure, 400) } : {}),
      ...(work.stopReason ? { stop_reason: work.stopReason } : {}),
      ...(work.replaces ? { replaces: work.replaces } : {}),
      ...(work.supersededBy ? { superseded_by: work.supersededBy } : {}),
      ...(work.attempts > 1 ? { attempts: work.attempts } : {}),
    })),
    ...(terminal.length > VIEW_MAX_TERMINAL ? { omitted_terminal_work: terminal.length - VIEW_MAX_TERMINAL } : {}),
    ...(graph.finish ? { finish: { result_ids: graph.finish.resultIds, reason: graph.finish.reason } } : {}),
    ...(options.history
      ? {
          history: engine
            .history()
            .slice(0, 10)
            .map((past) => ({
              graph_id: past.graphId,
              task: past.task,
              state: past.finish ? "finished" : "stopped",
              selected_result_ids: past.finish?.resultIds ?? [],
            })),
        }
      : {}),
  };
}

/** Maka agent_swarm_status projection: identity + status, never payload. */
export function swarmStatus(engine: GraphEngine, graph: GraphState): Record<string, unknown> {
  const items = graph.work.map((work) => {
    const status = engine.viewStatus(graph, work);
    return {
      work_id: work.workId,
      status,
      ...(work.resultId ? { result_id: work.resultId } : {}),
      ...(status === "failed" ? { failure: clip(work.failure ?? "failed", 300) } : {}),
      ...(status === "blocked" ? { failure: "an input failed or was stopped" } : {}),
      ...(work.operatorId ? { operator_id: work.operatorId } : {}),
    };
  });
  const attention: ReadonlySet<WorkViewStatus> = new Set(["blocked", "failed"]);
  const live = items.some((item) => item.status === "queued" || item.status === "running" || item.status === "blocked");
  const needsAttention = items.some((item) => attention.has(item.status));
  return {
    kind: "agent_swarm_status",
    swarm_id: graph.graphId,
    status: !live ? "settled" : needsAttention ? "needs_attention" : "running",
    closed: Boolean(graph.finish || graph.abandoned),
    counts: countStatuses(graph, (work) => engine.viewStatus(graph, work)),
    items,
  };
}

const workSchema = Type.Object({
  work_id: Type.Optional(Type.String({ description: "Short stable id for this work (e.g. scan-api). Later work names it in input_ids; its result id is r-<work_id>. Auto-assigned when omitted." })),
  instruction: Type.String({ description: "Bounded, self-contained instruction: scope, expected output, constraints. The child does not see this conversation." }),
  profile: Type.Optional(Type.String({ description: `Subagent profile for new work (default ${DEFAULT_PROFILE}; subagent_explore for read-only investigation).` })),
  operator_id: Type.Optional(Type.String({ description: "Follow-up work on an EXISTING operator (from view_agent_graph): resumes that child's session. Omit for new work." })),
  input_ids: Type.Optional(Type.Array(Type.String(), { description: `Work ids or result ids (r-<work_id>) of THIS graph whose committed results this work consumes (its dependencies). Max ${MAX_INPUT_IDS}.` })),
  selected_result_inputs: Type.Optional(
    Type.Array(
      Type.Object({
        source_graph_id: Type.String({ description: "A finished earlier graph (view_agent_graph history)." }),
        result_id: Type.String({ description: "A result id that graph's finish selected." }),
      }),
      { description: "Results selected by finished earlier graphs (data lineage only)." },
    ),
  ),
  replaces: Type.Optional(Type.String({ description: "A failed / blocked / obsolete work id this work supersedes." })),
});

export function registerGraphTools(pi: ExtensionAPI, deps: GraphToolDeps): void {
  const { engine } = deps;

  pi.registerTool({
    name: "update_agent_graph",
    label: "Update Agent Graph",
    description:
      "Adjust the durable agent graph. operation=add_work schedules work (the host runs it as subagents; dependencies via input_ids), operation=stop stops work, operation=finish closes the graph with the selected committed result ids. The first add_work opens a graph.",
    parameters: Type.Object({
      operation: Type.Optional(Type.Union([Type.Literal("add_work"), Type.Literal("stop"), Type.Literal("finish")], { description: "Always set it. Inferred from the one of add_work / stop / finish you set when omitted." })),
      task: Type.Optional(Type.String({ description: "One-line title of the overall graph (first add_work only)." })),
      add_work: Type.Optional(Type.Array(workSchema, { maxItems: MAX_ADD_WORK })),
      stop: Type.Optional(
        Type.Array(Type.Object({ target_id: Type.String({ description: "Work id or operator id." }), reason: Type.String() }), { maxItems: MAX_STOP }),
      ),
      finish: Type.Optional(
        Type.Object({
          result_ids: Type.Array(Type.String(), { description: "Committed result ids (r-<work_id>) selected as the final result.", maxItems: MAX_RESULT_IDS }),
          reason: Type.String(),
        }),
      ),
    }),
    execute: async (_id, params) => {
      const raw = params as { operation?: "add_work" | "stop" | "finish"; add_work?: unknown[]; stop?: unknown[]; finish?: unknown };
      const given = [raw.add_work?.length ? "add_work" : undefined, raw.stop?.length ? "stop" : undefined, raw.finish ? "finish" : undefined].filter((v): v is "add_work" | "stop" | "finish" => v !== undefined);
      const operation = raw.operation ?? (given.length === 1 ? given[0] : undefined);
      if (!operation) return textResult("Set operation (add_work, stop or finish) and the matching field.", undefined, true);
      const p = { ...(params as object), operation } as {
        operation: "add_work" | "stop" | "finish";
        task?: string;
        add_work?: Array<{ work_id?: string; instruction: string; profile?: string; operator_id?: string; input_ids?: string[]; selected_result_inputs?: Array<{ source_graph_id: string; result_id: string }>; replaces?: string }>;
        stop?: Array<{ target_id: string; reason: string }>;
        finish?: { result_ids: string[]; reason: string };
      };
      if (!engine.hasRunner()) {
        return textResult("Agent graph is unavailable: subagents are not loaded or are disabled in this session (check /unipi:settings → subagents).", undefined, true);
      }
      const available = deps.profiles();
      const addWork: AddWorkInput[] = [];
      if (p.operation === "add_work") {
        for (const work of p.add_work ?? []) {
          if (work.operator_id === undefined && work.profile !== undefined && available.length > 0 && !available.includes(work.profile)) {
            return textResult(`Unknown profile "${work.profile}". Available: ${available.join(", ")}.`, undefined, true);
          }
          addWork.push({
            ...(work.work_id !== undefined ? { workId: work.work_id.trim() } : {}),
            instruction: work.instruction,
            target: work.operator_id !== undefined ? { kind: "existing_operator", operatorId: work.operator_id } : { kind: "new_preset", subagentId: work.profile ?? DEFAULT_PROFILE },
            inputIds: work.input_ids ?? [],
            selectedResultInputs: (work.selected_result_inputs ?? []).map((s) => ({ sourceGraphId: s.source_graph_id, resultId: s.result_id })),
            ...(work.replaces !== undefined ? { replaces: work.replaces } : {}),
          });
        }
      }
      const result = engine.update({
        mode: deps.mode(),
        ...(p.task !== undefined ? { task: p.task } : {}),
        addWork: p.operation === "add_work" ? addWork : [],
        stop: p.operation === "stop" ? (p.stop ?? []).map((s) => ({ targetId: s.target_id, reason: s.reason })) : [],
        ...(p.operation === "finish" && p.finish ? { finish: { resultIds: p.finish.result_ids, reason: p.finish.reason } } : {}),
      });
      if (!result.ok) return textResult(`Graph update refused: ${result.reason}`, undefined, true);
      const graph = result.graph;
      if (result.closed) {
        return textResult(
          `Graph "${graph.task}" finished with ${graph.finish?.resultIds.length ?? 0} selected result(s). Read anything you still need with agent_output, then deduplicate, verify, and synthesize for the user.`,
          { graphId: graph.graphId },
        );
      }
      const counts = countStatuses(graph, (work) => engine.viewStatus(graph, work));
      const lines = [
        `${result.opened ? "Opened" : "Updated"} ${graph.mode} ${graph.graphId} "${graph.task}" (revision ${graph.revision}): ${Object.entries(counts).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(", ")}.`,
      ];
      if (result.started.length > 0) lines.push(`Started now: ${result.started.join(", ")}.`);
      const waiting = graph.work.filter((work) => work.status === "queued").map((work) => work.workId);
      if (waiting.length > 0) lines.push(`Waiting (inputs or capacity): ${waiting.join(", ")}.`);
      lines.push("The host runs the work. Call yield_agent_graph now unless you have other immediate supervision to do; you will be woken at the next checkpoint.");
      return textResult(lines.join("\n"), { graphId: graph.graphId });
    },
  });

  pi.registerTool({
    name: "view_agent_graph",
    label: "View Agent Graph",
    description: "Inspect the durable agent graph: work status, waits, operators, failures, committed result ids, and (history:true) earlier graphs.",
    parameters: Type.Object({
      graph_id: Type.Optional(Type.String({ description: "An earlier graph id; default the current graph." })),
      history: Type.Optional(Type.Boolean({ description: "Include the list of earlier graphs." })),
    }),
    execute: async (_id, params) => {
      const p = params as { graph_id?: string; history?: boolean };
      const graph = p.graph_id ? engine.graph(p.graph_id) : engine.current();
      if (!graph) {
        if (p.history && engine.history().length > 0) {
          return textResult(JSON.stringify({ current: null, history: engine.history().slice(0, 10).map((past) => ({ graph_id: past.graphId, task: past.task, state: past.finish ? "finished" : "stopped", selected_result_ids: past.finish?.resultIds ?? [] })) }, null, 2));
        }
        return textResult(p.graph_id ? `No graph ${p.graph_id}.` : "No agent graph yet — schedule work with update_agent_graph operation=add_work.");
      }
      return textResult(JSON.stringify(graphView(engine, graph, { history: p.history === true }), null, 2));
    },
  });

  pi.registerTool({
    name: "yield_agent_graph",
    label: "Yield Agent Graph",
    description:
      "End this supervisor turn successfully while scheduled graph work continues. Call this after the current scheduling wave has no immediate decision; do not poll, sleep, or emit a waiting message. The host will start a new supervisor turn at the next durable graph checkpoint. This does not finish or close the graph.",
    parameters: Type.Object({ reason: Type.Optional(Type.String({ description: "Short note on what you are waiting for." })) }),
    execute: async () => {
      const graph = engine.open();
      if (!graph) return textResult("No open agent graph — nothing to yield for. Finish your answer instead.", undefined, true);
      const running = graph.work.filter((work) => work.status === "running").length;
      const queued = graph.work.filter((work) => engine.viewStatus(graph, work) === "queued").length;
      if (running === 0 && queued === 0) {
        return textResult("Agent graph has no in-flight or pending work that can produce a future checkpoint; inspect results and finish or update the graph instead.", undefined, true);
      }
      return { ...textResult(`Yielded: ${running} running, ${queued} waiting. You will be woken at the next checkpoint.`), terminate: true };
    },
  });

  pi.registerTool({
    name: "agent_output",
    label: "Agent Output",
    description: "Read a graph work item's committed result (or its failure / partial output) by result id (r-<work_id>) or work id. Use for final results you rely on or narrow failure diagnosis.",
    parameters: Type.Object({
      id: Type.String({ description: "Result id (r-<work_id>) or work id." }),
      graph_id: Type.Optional(Type.String({ description: "An earlier graph id; default: current graph, then history." })),
      max_bytes: Type.Optional(Type.Number({ description: `Default ${OUTPUT_DEFAULT_BYTES}, max ${OUTPUT_MAX_BYTES}.` })),
    }),
    execute: async (_id, params) => {
      const p = params as { id: string; graph_id?: string; max_bytes?: number };
      const found = engine.readResult(p.id.trim(), p.graph_id);
      if (!found) return textResult(`No graph work or result ${p.id}.`, undefined, true);
      const { work } = found;
      const max = Math.max(1024, Math.min(OUTPUT_MAX_BYTES, p.max_bytes ?? OUTPUT_DEFAULT_BYTES));
      const head = `work ${work.workId} · ${work.status}${work.resultId ? ` · result ${work.resultId}` : ""}${work.operatorId ? ` · operator ${work.operatorId}` : ""} · graph ${found.graphId}`;
      if (work.status === "completed" || work.result) {
        const text = work.result ?? "";
        const bytes = Buffer.byteLength(text, "utf8");
        const body = bytes > max ? `${Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "")}\n[…truncated: ${bytes} bytes]` : text;
        return textResult(`${head}${work.resultTruncated ? " · stored text truncated" : ""}\n\n${body}`);
      }
      if (work.status === "failed") return textResult(`${head}\nFailure: ${work.failure ?? "unknown"}`);
      return textResult(`${head}\nNo committed result yet.`);
    },
  });

  pi.registerTool({
    name: "agent_swarm_status",
    label: "Agent Swarm Status",
    description: "Compact swarm status: per-item status and result ids (never payload), plus running | needs_attention | settled. Read results with agent_output.",
    parameters: Type.Object({}),
    execute: async () => {
      const graph = engine.current();
      if (!graph) return textResult("No swarm yet — schedule items with update_agent_graph operation=add_work.");
      return textResult(JSON.stringify(swarmStatus(engine, graph), null, 2));
    },
  });
}
