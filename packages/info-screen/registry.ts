/**
 * @pi-unipi/info-screen — Registry
 *
 * Central registry for info groups. Core groups register at startup.
 * External modules call registerGroup() to add their groups.
 */

import type { InfoGroup, GroupData } from "./types.js";
import { getInfoSettings, isGroupEnabled, isStatEnabled } from "./config.js";

/**
 * Registry for info-screen groups.
 *
 * Usage:
 * ```ts
 * import { infoRegistry } from "@pi-unipi/info-screen";
 *
 * // Register a group
 * infoRegistry.registerGroup({
 *   id: "memory",
 *   name: "Memory",
 *   icon: "🧠",
 *   priority: 60,
 *   config: {
 *     showByDefault: true,
 *     stats: [
 *       { id: "total", label: "Total", show: true },
 *     ],
 *   },
 *   dataProvider: async () => ({
 *     total: { value: "42" },
 *   }),
 * });
 *
 * // Get all registered groups
 * const groups = infoRegistry.getGroups();
 * ```
 */
class InfoRegistry {
  /** Registered groups by id */
  private groups = new Map<string, InfoGroup>();

  /** Cached data per group */
  private dataCache = new Map<string, GroupData>();

  /** Cache TTL in ms */
  private cacheTtlMs = 5000;

  /** Last cache update per group */
  private cacheTimestamps = new Map<string, number>();

  /**
   * Register an info group.
   * If a group with the same id exists, it's replaced.
   */
  registerGroup(group: InfoGroup): void {
    console.debug(`[info-screen] Registering group: ${group.id}`);
    this.groups.set(group.id, group);
  }

  /**
   * Unregister an info group.
   */
  unregisterGroup(groupId: string): void {
    this.groups.delete(groupId);
    this.dataCache.delete(groupId);
    this.cacheTimestamps.delete(groupId);
  }

  /**
   * Get all registered groups, sorted by priority.
   * Respects config — groups with show: false are excluded.
   */
  getGroups(): InfoGroup[] {
    const settings = getInfoSettings();
    const allGroups = Array.from(this.groups.values());
    console.debug(`[info-screen] getGroups: ${allGroups.length} total groups`);

    return allGroups
      .filter((group) => {
        // Check group-level visibility
        const groupSettings = settings.groups[group.id];
        if (groupSettings && !groupSettings.show) return false;
        // If no settings, use group's default
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
   * Get data for a group, using cache if fresh.
   */
  async getGroupData(groupId: string): Promise<GroupData> {
    const group = this.groups.get(groupId);
    if (!group) return {};

    // Check cache freshness
    const now = Date.now();
    const lastUpdate = this.cacheTimestamps.get(groupId) ?? 0;
    if (now - lastUpdate < this.cacheTtlMs) {
      const cached = this.dataCache.get(groupId);
      if (cached) return cached;
    }

    // Fetch fresh data
    try {
      const data = await group.dataProvider();
      this.dataCache.set(groupId, data);
      this.cacheTimestamps.set(groupId, now);
      return data;
    } catch (error) {
      console.debug(`[info-screen] Error fetching data for group ${groupId}:`, error);
      return this.dataCache.get(groupId) ?? {};
    }
  }

  /**
   * Manually update data for a group (for live updates).
   */
  updateGroupData(groupId: string, data: GroupData): void {
    this.dataCache.set(groupId, data);
    this.cacheTimestamps.set(groupId, Date.now());
  }

  /**
   * Get filtered stats for a group based on config.
   * Returns stats that are enabled in both group config and settings.
   */
  getVisibleStats(groupId: string): Array<{ id: string; label: string }> {
    const group = this.groups.get(groupId);
    if (!group) return [];

    return group.config.stats.filter((stat) => {
      // Check stat-level visibility from settings
      if (!isStatEnabled(groupId, stat.id)) return false;
      // Check stat's own default
      return stat.show;
    });
  }

  /**
   * Invalidate cache for a group.
   */
  invalidateCache(groupId: string): void {
    this.dataCache.delete(groupId);
    this.cacheTimestamps.delete(groupId);
  }

  /**
   * Invalidate all caches.
   */
  invalidateAllCaches(): void {
    this.dataCache.clear();
    this.cacheTimestamps.clear();
  }
}

/** Singleton registry instance */
export const infoRegistry = new InfoRegistry();
