/**
 * Shared SubagentManager accessor (same pattern as background-tasks'
 * registry-shared.ts): the manager instance owns `cancel`/`setBackground`/
 * `events`/`toolCalls`/`usage`, which `getSharedSubagents()` (module-level
 * records) does not expose. Published on globalThis under a `Symbol.for`
 * key so sibling extensions (the app bridge's work adapter) can reach it
 * without a hard dependency on this package.
 */
import type { SubagentManager, SubagentRecord } from "./manager.js";
import { getSharedSubagents } from "./manager.js";

const SHARED_MANAGER_KEY = Symbol.for("unipi.subagents.shared-manager");
/** Plain function reference to `getSharedSubagents` (module-level records,
 *  not itself globalThis-based) — published so a sibling extension can read
 *  the list without a hard dependency on this package. */
const SHARED_LIST_KEY = Symbol.for("unipi.subagents.shared-list");

/** Publish the live manager (idempotent; later calls overwrite). */
export function setSharedSubagentManager(manager: SubagentManager): void {
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_MANAGER_KEY] = manager;
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_LIST_KEY] ??= (): readonly SubagentRecord[] => getSharedSubagents();
}

/** Read the live manager, or undefined when subagents is not loaded. */
export function getSharedSubagentManager(): SubagentManager | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SHARED_MANAGER_KEY] as SubagentManager | undefined;
}

/** Drop the shared reference (used on session shutdown so readers see a clean slate). */
export function clearSharedSubagentManager(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[SHARED_MANAGER_KEY];
}
