/**
 * Shared TpsTracker accessor (same pattern as background-tasks'
 * registry-shared.ts): exposes the live session tracker to sibling
 * extensions (the app bridge's stats push, UNI-160 §3) without a hard
 * dependency on @pi-unipi/footer.
 */
import { tpsTracker, type TpsTracker } from "./tps-tracker.js";

const SHARED_TPS_KEY = Symbol.for("unipi.footer.shared-tps");

/** Idempotent: the module-level singleton is always the same instance, so
 *  this just makes it reachable from globalThis too. */
export function publishSharedTps(): void {
  (globalThis as unknown as Record<symbol, unknown>)[SHARED_TPS_KEY] = tpsTracker;
}

export function getSharedTps(): TpsTracker | undefined {
  return (globalThis as unknown as Record<symbol, unknown>)[SHARED_TPS_KEY] as TpsTracker | undefined;
}
