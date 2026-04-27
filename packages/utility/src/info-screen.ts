/**
 * @pi-unipi/utility — Info-Screen Integration
 *
 * Registers utility stats group for the info-screen overlay.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  emitEvent,
} from "@pi-unipi/core";
import { getLifecycle } from "./lifecycle/process.js";
import { getAnalyticsCollector } from "./analytics/collector.js";

/** Info group ID */
const GROUP_ID = "utility";

/** Info group display name */
const GROUP_NAME = "Utility";

/**
 * Register the utility info-screen group.
 */
export function registerInfoScreen(pi: ExtensionAPI): void {
  // Announce group registration
  emitEvent(pi, UNIPI_EVENTS.INFO_GROUP_REGISTERED, {
    groupId: GROUP_ID,
    groupName: GROUP_NAME,
    module: MODULES.UTILITY,
  });

  // Listen for status requests
  pi.on("session_start", async () => {
    // Module is ready — data will be served on demand
  });
}

/**
 * Get current utility stats for info-screen display.
 */
export function getUtilityStats(): Record<string, unknown> {
  const lifecycle = getLifecycle();
  const analytics = getAnalyticsCollector();

  const events = analytics.getEvents();
  const rollup = analytics.getRollup();

  return {
    uptime: process.uptime(),
    state: lifecycle.currentState,
    isOrphaned: lifecycle.isOrphaned,
    eventsToday: Object.values(rollup.events).reduce((a, b) => a + b, 0),
    errorsToday: rollup.errorCount,
    totalEvents: events.length,
    nodeVersion: process.version,
    platform: process.platform,
  };
}

/**
 * Format utility stats as markdown for display.
 */
export function formatUtilityStats(stats: Record<string, unknown>): string {
  const lines = [
    `**State:** ${stats.state}`,
    `**Uptime:** ${Math.round((stats.uptime as number) / 60)}m`,
    `**Events today:** ${stats.eventsToday}`,
    `**Errors today:** ${stats.errorsToday}`,
    `**Total events:** ${stats.totalEvents}`,
    `**Node:** ${stats.nodeVersion}`,
    `**Platform:** ${stats.platform}`,
  ];

  if (stats.isOrphaned) {
    lines.push("⚠️ **Orphaned process detected**");
  }

  return lines.join("\n");
}
