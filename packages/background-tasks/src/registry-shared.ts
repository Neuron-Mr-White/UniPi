/**
 * Shared BackgroundTaskRegistry accessor
 *
 * Exposes the live registry to sibling extensions (e.g. @pi-unipi/footer)
 * without events or request/response channels — direct synchronous reads of
 * `allTasks()`.
 *
 * Stored on globalThis under a `Symbol.for` key so the singleton is shared
 * even if this package ends up instantiated more than once (duplicate
 * node_modules copies would otherwise each hold their own module state).
 */

import type { BackgroundTaskRegistry } from "./registry.js";

const SHARED_REGISTRY_KEY = Symbol.for("unipi.background-tasks.shared-registry");

/** Publish the live registry (idempotent; later calls overwrite). */
export function setSharedTaskRegistry(registry: BackgroundTaskRegistry): void {
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_REGISTRY_KEY] = registry;
}

/** Read the live registry, or undefined when background-tasks is not loaded. */
export function getSharedTaskRegistry(): BackgroundTaskRegistry | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SHARED_REGISTRY_KEY] as
    | BackgroundTaskRegistry
    | undefined;
}

/** Drop the shared reference (used on session shutdown so readers see a clean slate). */
export function clearSharedTaskRegistry(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[SHARED_REGISTRY_KEY];
}
