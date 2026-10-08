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

/** Change listeners for the shared registry (UNI-126 tray change signal):
 *  core's work-list module subscribes here instead of polling every frame.
 *  Kept on globalThis too so every loaded copy of this package shares one
 *  listener set. */
const CHANGE_KEY = Symbol.for("unipi.background-tasks.shared-registry-changed");
function changeListeners(): Set<() => void> {
  const g = globalThis as unknown as Record<symbol, Set<() => void>>;
  g[CHANGE_KEY] ??= new Set();
  return g[CHANGE_KEY];
}

/** Subscribe to "the registry changed" (task started/finished/output…).
 *  Returns an unsubscribe function. */
export function subscribeTaskRegistryChanges(listener: () => void): () => void {
  const set = changeListeners();
  set.add(listener);
  return () => set.delete(listener);
}

/** Notify subscribers (called from the registry's own onChange hook). */
export function notifyTaskRegistryChange(): void {
  for (const listener of [...changeListeners()]) {
    try {
      listener();
    } catch {
      // A broken listener must never break the others.
    }
  }
}

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
