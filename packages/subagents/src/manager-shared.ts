/**
 * Shared SubagentManager accessor (same pattern as background-tasks'
 * registry-shared.ts): the manager instance owns `cancel`/`setBackground`/
 * `events`/`toolCalls`/`usage`, which `getSharedSubagents()` (module-level
 * records) does not expose. Published on globalThis under a `Symbol.for`
 * key so sibling extensions (the app bridge's work adapter) can reach it
 * without a hard dependency on this package.
 */
import type { SubagentManager, SubagentRecord } from "./manager.js";
import { getSharedSubagents, subscribeSubagents } from "./manager.js";

const SHARED_MANAGER_KEY = Symbol.for("unipi.subagents.shared-manager");
/** Plain function reference to `getSharedSubagents` (module-level records,
 *  not itself globalThis-based) — published so a sibling extension can read
 *  the list without a hard dependency on this package. */
const SHARED_LIST_KEY = Symbol.for("unipi.subagents.shared-list");
/** Plain function reference to `subscribeSubagents` (UNI-126 tray change
 *  signal): lets core's work-list module react to record changes instead of
 *  polling every frame. */
const SHARED_SUBSCRIBE_KEY = Symbol.for("unipi.subagents.shared-subscribe");

/** Publish the live manager (idempotent; later calls overwrite). */
export function setSharedSubagentManager(manager: SubagentManager): void {
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_MANAGER_KEY] = manager;
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_LIST_KEY] ??= (): readonly SubagentRecord[] => getSharedSubagents();
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_SUBSCRIBE_KEY] ??= (listener: () => void) => subscribeSubagents(listener);
}

/** Read the live manager, or undefined when subagents is not loaded. */
export function getSharedSubagentManager(): SubagentManager | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SHARED_MANAGER_KEY] as SubagentManager | undefined;
}

/** Drop the shared reference (used on session shutdown so readers see a clean slate). */
export function clearSharedSubagentManager(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[SHARED_MANAGER_KEY];
  delete (globalThis as unknown as Record<symbol, unknown>)[GRAPH_RUN_PORT_KEY];
}

/**
 * UNI-280: the background-run port long-horizon's Agent Graph uses to run
 * its work as subagents (the framework dispatches, not the model). Same
 * `Symbol.for` handshake — no hard dependency either way. The graph owns
 * completion: runs started here send no <subagent_completion_notification>.
 */
export const GRAPH_RUN_PORT_KEY = Symbol.for("unipi.subagents.graph-run-port");

export interface GraphRunOutcome {
  status: "completed" | "failed" | "cancelled";
  text: string;
  error?: string;
  toolCalls: number;
  usage?: { input?: number; output?: number; cost?: number };
}

export interface GraphRunPort {
  /** Profile ids available to new graph work. */
  profiles(): string[];
  /** Start (or resume) a background run. Synchronous admission. */
  start(request: { title: string; task: string; profile: string; resume?: string; onDone: (outcome: GraphRunOutcome) => void }): { id: string } | { error: string; retryable?: boolean };
  cancel(id: string): boolean;
}

export function setGraphRunPort(port: GraphRunPort | undefined): void {
  const slot = globalThis as unknown as Record<symbol, unknown>;
  if (port) slot[GRAPH_RUN_PORT_KEY] = port;
  else delete slot[GRAPH_RUN_PORT_KEY];
}
