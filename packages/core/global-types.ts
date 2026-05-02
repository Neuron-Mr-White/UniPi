/**
 * @unipi/core — Minimal interfaces for global registry objects
 *
 * These interfaces cover the methods that external packages call.
 * The actual implementations live in their respective packages
 * (info-screen, footer, mcp) and may have richer APIs.
 */

/** Stat data shape returned by info data providers */
export interface StatDataLike {
  value: string;
  detail?: string;
}

/** Minimal InfoRegistry interface for external consumers */
export interface InfoRegistryLike {
  registerGroup(group: {
    id: string;
    name: string;
    icon: string;
    priority: number;
    config: {
      showByDefault: boolean;
      stats: Array<{ id: string; label: string; show: boolean }>;
    };
    dataProvider: () => Promise<Record<string, unknown>>;
  }): void;
  getGroupData(groupId: string): Promise<Record<string, unknown>>;
  getCachedData(groupId: string): Record<string, unknown> | null;
  invalidateCache(groupId: string): void;
  refreshGroup(groupId: string): Record<string, unknown> | null;
  refreshAll(): void;
}

/** Minimal FooterRegistry interface for external consumers */
export interface FooterRegistryLike {
  registerGroup(group: unknown): void;
}

/** MCP stats shape exposed via globalThis */
export interface McpStatsLike {
  serversTotal?: number;
  serversActive?: number;
  serversFailed?: number;
  toolsTotal?: number;
}
