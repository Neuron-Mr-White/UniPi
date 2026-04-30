/**
 * @pi-unipi/footer — FooterRegistry
 *
 * Central registry for segment groups with event subscription,
 * data caching, and reactive updates.
 */

import type { FooterGroup } from "../types.js";

/** Type for the reactive update callback */
type UpdateCallback = () => void;

/**
 * FooterRegistry manages segment groups and their cached data.
 * It subscribes to UNIPI_EVENTS, caches data per group, and
 * notifies subscribers when data changes.
 */
export class FooterRegistry {
  /** Registered segment groups */
  private groups = new Map<string, FooterGroup>();

  /** Cached event data per group */
  private dataCache = new Map<string, unknown>();

  /** Reactive update subscribers */
  private subscribers = new Set<UpdateCallback>();

  /** Whether to log debug info */
  private debug: boolean;

  constructor(options?: { debug?: boolean }) {
    this.debug = options?.debug ?? false;
  }

  // ─── Group Management ─────────────────────────────────────────────────────

  /**
   * Register a segment group.
   */
  registerGroup(group: FooterGroup): void {
    this.groups.set(group.id, group);
    this.log("registerGroup", group.id);
  }

  /**
   * Get a registered group by ID.
   */
  getGroup(groupId: string): FooterGroup | undefined {
    return this.groups.get(groupId);
  }

  /**
   * Get all registered groups.
   */
  getAllGroups(): FooterGroup[] {
    return Array.from(this.groups.values());
  }

  // ─── Data Cache ───────────────────────────────────────────────────────────

  /**
   * Update cached data for a group and notify subscribers.
   */
  updateData(groupId: string, data: unknown): void {
    const previous = this.dataCache.get(groupId);
    // Only notify if data actually changed (shallow compare)
    if (previous === data) return;

    this.dataCache.set(groupId, data);
    this.log("updateData", groupId, data);
    this.notifySubscribers();
  }

  /**
   * Get cached data for a group.
   */
  getGroupData(groupId: string): unknown {
    return this.dataCache.get(groupId);
  }

  /**
   * Clear all cached data.
   */
  invalidateAll(): void {
    this.dataCache.clear();
    this.log("invalidateAll");
    this.notifySubscribers();
  }

  /**
   * Clear cached data for a specific group.
   */
  invalidateGroup(groupId: string): void {
    this.dataCache.delete(groupId);
    this.log("invalidateGroup", groupId);
    this.notifySubscribers();
  }

  // ─── Reactive Subscriptions ───────────────────────────────────────────────

  /**
   * Subscribe to data updates. Returns an unsubscribe function.
   */
  subscribe(callback: UpdateCallback): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers of a data change.
   */
  private notifySubscribers(): void {
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch (err) {
        console.error("[footer] Subscriber error:", err);
      }
    }
  }

  // ─── Debug ────────────────────────────────────────────────────────────────

  private log(event: string, ...args: unknown[]): void {
    if (!this.debug) return;
    const ts = new Date().toISOString().slice(11, 23);
    const details = args.length > 0 ? " " + JSON.stringify(args) : "";
    console.error(`[footer-registry:${ts}] ${event}${details}`);
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

/** Global registry instance */
let registryInstance: FooterRegistry | null = null;

/**
 * Get the global FooterRegistry instance.
 * Creates one on first call.
 */
export function getFooterRegistry(): FooterRegistry {
  if (!registryInstance) {
    registryInstance = new FooterRegistry();
  }
  return registryInstance;
}

/**
 * Reset the global registry (for testing).
 */
export function resetFooterRegistry(): void {
  registryInstance = null;
}

// ─── Global reference ───────────────────────────────────────────────────────

// Expose on globalThis for cross-package access
if (typeof globalThis !== "undefined") {
  (globalThis as Record<string, unknown>).__unipi_footer_registry = getFooterRegistry();
}
