/**
 * @pi-unipi/footer — Shared status data store
 *
 * A tiny cache keyed by group id. Glance widgets cache per-group render data
 * here; the bus (bus.ts) is the cross-module state channel.
 */

/** Type for the reactive update callback */
type UpdateCallback = () => void;

export class FooterRegistry {
  /** Cached event data per group */
  private dataCache = new Map<string, unknown>();

  /** Reactive update subscribers */
  private subscribers = new Set<UpdateCallback>();

  // ─── Data Cache ───────────────────────────────────────────────────────────

  /**
   * Update cached data for a group and notify subscribers.
   */
  updateData(groupId: string, data: unknown): void {
    const previous = this.dataCache.get(groupId);
    // Only notify if data actually changed (shallow compare)
    if (previous === data) return;

    this.dataCache.set(groupId, data);
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
      } catch {
        // Silently ignore — subscriber errors are non-blocking.
      }
    }
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
