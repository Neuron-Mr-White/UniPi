/**
 * @pi-unipi/info-screen — Registry
 *
 * Central registry for info groups with cache-first reactive model.
 * Groups load independently; overlay subscribes to per-group updates.
 */

import type { InfoGroup, GroupData } from "./types.js";
import { getInfoSettings, isStatEnabled } from "./config.js";

/** Callback for reactive updates */
type GroupUpdateCallback = (groupId: string, data: GroupData) => void;

class InfoRegistry {
  /** Registered groups by id */
  private groups = new Map<string, InfoGroup>();

  /** Cached data per group */
  private dataCache = new Map<string, GroupData>();

  /** Last successful fetch timestamp per group */
  private lastUpdated = new Map<string, number>();

  /** Cache TTL in ms */
  private cacheTtlMs = 5000;

  /** Subscribers per group */
  private subscribers = new Map<string, Set<GroupUpdateCallback>>();

  /** Global subscribers (any group update) */
  private globalSubscribers = new Set<GroupUpdateCallback>();

  /** In-flight fetches per group */
  private inflight = new Map<string, Promise<GroupData>>();

  /**
   * Register an info group.
   * Notifies subscribers so overlays can pick up late-arriving groups.
   */
  registerGroup(group: InfoGroup): void {
    this.groups.set(group.id, group);
    // Notify that a new group appeared (triggers overlay sync)
    this.notifyGroupRegistered(group.id);
  }

  /**
   * Unregister an info group.
   */
  unregisterGroup(groupId: string): void {
    this.groups.delete(groupId);
    this.dataCache.delete(groupId);
    this.lastUpdated.delete(groupId);
    this.subscribers.delete(groupId);
  }

  /**
   * Get all registered groups, sorted by priority.
   */
  getGroups(): InfoGroup[] {
    const settings = getInfoSettings();
    const allGroups = Array.from(this.groups.values());

    return allGroups
      .filter((group) => {
        const groupSettings = settings.groups[group.id];
        if (groupSettings && !groupSettings.show) return false;
        if (!groupSettings && !group.config.showByDefault) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get all registered groups (including hidden ones).
   */
  getAllGroups(): InfoGroup[] {
    return Array.from(this.groups.values())
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Get a specific group by id.
   */
  getGroup(groupId: string): InfoGroup | undefined {
    return this.groups.get(groupId);
  }

  /**
   * Synchronous: get cached data for immediate display.
   * Returns null if never fetched.
   */
  getCachedData(groupId: string): GroupData | null {
    return this.dataCache.get(groupId) ?? null;
  }

  /**
   * Synchronous: get last updated timestamp for a group.
   */
  getLastUpdated(groupId: string): number {
    return this.lastUpdated.get(groupId) ?? 0;
  }

  /**
   * Synchronous: check if a group is currently fetching.
   */
  isFetching(groupId: string): boolean {
    return this.inflight.has(groupId);
  }

  /**
   * Get data for a group, using cache if fresh.
   * Returns immediately from cache if fresh, otherwise fetches in background
   * and notifies subscribers when done.
   */
  async getGroupData(groupId: string): Promise<GroupData> {
    const group = this.groups.get(groupId);
    if (!group) return {};

    // Check cache freshness
    const now = Date.now();
    const lastUpdate = this.lastUpdated.get(groupId) ?? 0;
    if (now - lastUpdate < this.cacheTtlMs) {
      const cached = this.dataCache.get(groupId);
      if (cached) return cached;
    }

    // Deduplicate in-flight requests
    const existing = this.inflight.get(groupId);
    if (existing) return existing;

    // Fetch fresh data
    const fetchPromise = this.fetchGroupData(groupId, group);
    this.inflight.set(groupId, fetchPromise);

    try {
      const data = await fetchPromise;
      return data;
    } finally {
      this.inflight.delete(groupId);
    }
  }

  /**
   * Background fetch: update cache and notify subscribers.
   * Does not throw — falls back to cached data.
   */
  private async fetchGroupData(groupId: string, group: InfoGroup): Promise<GroupData> {
    try {
      const data = await group.dataProvider();
      this.dataCache.set(groupId, data);
      this.lastUpdated.set(groupId, Date.now());
      this.notifySubscribers(groupId, data);
      return data;
    } catch {
      return this.dataCache.get(groupId) ?? {};
    }
  }

  /**
   * Trigger a background refresh for a group.
   * Returns cached data immediately if available.
   */
  refreshGroup(groupId: string): GroupData | null {
    const cached = this.dataCache.get(groupId) ?? null;
    // Fire and forget
    this.getGroupData(groupId);
    return cached;
  }

  /**
   * Refresh all groups in background.
   */
  refreshAll(): void {
    for (const [id, group] of this.groups) {
      this.fetchGroupData(id, group);
    }
  }

  /**
   * Subscribe to updates for a specific group.
   * Returns unsubscribe function.
   */
  subscribe(groupId: string, callback: GroupUpdateCallback): () => void {
    if (!this.subscribers.has(groupId)) {
      this.subscribers.set(groupId, new Set());
    }
    this.subscribers.get(groupId)!.add(callback);

    return () => {
      this.subscribers.get(groupId)?.delete(callback);
    };
  }

  /**
   * Subscribe to all group updates.
   * Returns unsubscribe function.
   */
  subscribeAll(callback: GroupUpdateCallback): () => void {
    this.globalSubscribers.add(callback);
    return () => {
      this.globalSubscribers.delete(callback);
    };
  }

  private notifySubscribers(groupId: string, data: GroupData): void {
    // Per-group subscribers
    const groupSubs = this.subscribers.get(groupId);
    if (groupSubs) {
      for (const cb of groupSubs) {
        try { cb(groupId, data); } catch { /* ignore */ }
      }
    }

    // Global subscribers
    for (const cb of this.globalSubscribers) {
      try { cb(groupId, data); } catch { /* ignore */ }
    }
  }

  /**
   * Get filtered stats for a group based on config.
   */
  getVisibleStats(groupId: string): Array<{ id: string; label: string }> {
    const group = this.groups.get(groupId);
    if (!group) return [];

    if (!group.config?.stats) return [];
    return group.config.stats.filter((stat) => {
      if (!isStatEnabled(groupId, stat.id)) return false;
      return stat.show;
    });
  }

  /**
   * Invalidate cache for a group.
   */
  invalidateCache(groupId: string): void {
    this.dataCache.delete(groupId);
    this.lastUpdated.delete(groupId);
  }

  /**
   * Invalidate all caches.
   */
  invalidateAllCaches(): void {
    this.dataCache.clear();
    this.lastUpdated.clear();
  }

  /**
   * Notify that a new group was registered.
   * Subscribers can use this to sync group lists.
   */
  private notifyGroupRegistered(groupId: string): void {
    // Fire a dummy update so overlays re-sync their group list
    for (const cb of this.globalSubscribers) {
      try { cb(groupId, {} as GroupData); } catch { /* ignore */ }
    }
  }
}

/** Singleton registry instance */
export const infoRegistry = new InfoRegistry();

// Expose globally so other modules can access without direct imports
const globalObj = globalThis as any;
if (!globalObj.__unipi_info_registry) {
  globalObj.__unipi_info_registry = infoRegistry;
}
export const getGlobalRegistry = (): InfoRegistry => {
  return globalObj.__unipi_info_registry || infoRegistry;
};
