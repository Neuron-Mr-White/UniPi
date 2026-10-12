/**
 * GraphRunner over the subagents package's background-run port (UNI-280).
 * Resolved through a `Symbol.for` global (published by @pi-unipi/subagents),
 * so long-horizon has no hard dependency on subagents and works without it
 * (the tools then refuse with a clear reason).
 */

import type { GraphRunner, WorkOutcome } from "./engine.js";

export const GRAPH_RUN_PORT_KEY = Symbol.for("unipi.subagents.graph-run-port");

/** Mirror of subagents' GraphRunPort (kept structural on purpose). */
export interface GraphRunPortLike {
  profiles(): string[];
  start(request: {
    title: string;
    task: string;
    profile: string;
    resume?: string;
    onDone: (outcome: { status: "completed" | "failed" | "cancelled"; text: string; error?: string; toolCalls: number; usage?: { input?: number; output?: number; cost?: number } }) => void;
  }): { id: string } | { error: string; retryable?: boolean };
  cancel(id: string): boolean;
}

export function readGraphRunPort(): GraphRunPortLike | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[GRAPH_RUN_PORT_KEY] as GraphRunPortLike | undefined;
}

export function graphRunnerFromPort(
  port: GraphRunPortLike,
  settle: (graphId: string, workId: string, outcome: WorkOutcome) => void,
): GraphRunner {
  return {
    start(request) {
      const started = port.start({
        title: request.title,
        task: request.task,
        profile: request.subagentId,
        ...(request.resumeOperatorId ? { resume: request.resumeOperatorId } : {}),
        onDone: (outcome) => settle(request.graphId, request.workId, outcome),
      });
      if ("error" in started) return { error: started.error, ...(started.retryable ? { retryable: true } : {}) };
      return { operatorId: started.id };
    },
    stop(operatorId) {
      port.cancel(operatorId);
    },
  };
}
