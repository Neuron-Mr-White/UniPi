/**
 * @pi-unipi/footer — Event subscription wiring
 *
 * Wires FooterRegistry to UNIPI_EVENTS for all relevant events.
 * Each event handler updates the registry cache for the appropriate group.
 *
 * Note: pi.events.on() returns an unsubscribe function directly.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_EVENTS } from "@pi-unipi/core";
import type { FooterRegistry } from "./registry/index.js";

/** Cleanup function returned by subscribeToEvents */
type UnsubscribeFn = () => void;

/**
 * Subscribe to all relevant UNIPI_EVENTS and wire them to the registry.
 * Returns an unsubscribe function for cleanup on session shutdown.
 */
export function subscribeToEvents(
  pi: ExtensionAPI,
  registry: FooterRegistry,
): UnsubscribeFn {
  const unsubscribers: UnsubscribeFn[] = [];

  // ─── Compactor events ───────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.COMPACTOR_STATS_UPDATED, (event: unknown) => {
      try {
        registry.updateData("compactor", event);
      } catch (err) {
        console.error("[footer] Compactor stats handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.COMPACTOR_COMPACTED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("compactor") as Record<string, unknown> | undefined;
        registry.updateData("compactor", { ...existing, lastCompaction: event });
      } catch (err) {
        console.error("[footer] Compaction handler error:", err);
      }
    })
  );

  // ─── Memory events ─────────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MEMORY_STORED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("memory") as Record<string, unknown> | undefined;
        registry.updateData("memory", { ...existing, lastStored: event });
      } catch (err) {
        console.error("[footer] Memory stored handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MEMORY_DELETED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("memory") as Record<string, unknown> | undefined;
        registry.updateData("memory", { ...existing, lastDeleted: event });
      } catch (err) {
        console.error("[footer] Memory deleted handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MEMORY_CONSOLIDATED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("memory") as Record<string, unknown> | undefined;
        registry.updateData("memory", { ...existing, lastConsolidated: event });
      } catch (err) {
        console.error("[footer] Memory consolidated handler error:", err);
      }
    })
  );

  // ─── MCP events ────────────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_SERVER_STARTED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        registry.updateData("mcp", { ...existing, lastServerStarted: event });
      } catch (err) {
        console.error("[footer] MCP server started handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_SERVER_STOPPED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        registry.updateData("mcp", { ...existing, lastServerStopped: event });
      } catch (err) {
        console.error("[footer] MCP server stopped handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_SERVER_ERROR, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        registry.updateData("mcp", { ...existing, lastServerError: event });
      } catch (err) {
        console.error("[footer] MCP server error handler error:", err);
      }
    })
  );

  // ─── Ralph events ──────────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.RALPH_LOOP_START, (event: unknown) => {
      try {
        registry.updateData("ralph", { ...(event as Record<string, unknown>), active: true });
      } catch (err) {
        console.error("[footer] Ralph loop start handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.RALPH_LOOP_END, (event: unknown) => {
      try {
        registry.updateData("ralph", { ...(event as Record<string, unknown>), active: false });
      } catch (err) {
        console.error("[footer] Ralph loop end handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.RALPH_ITERATION_DONE, (event: unknown) => {
      try {
        const existing = registry.getGroupData("ralph") as Record<string, unknown> | undefined;
        registry.updateData("ralph", { ...existing, lastIteration: event });
      } catch (err) {
        console.error("[footer] Ralph iteration handler error:", err);
      }
    })
  );

  // ─── Workflow events ───────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.WORKFLOW_START, (event: unknown) => {
      try {
        registry.updateData("workflow", { ...(event as Record<string, unknown>), active: true, startTime: Date.now() });
      } catch (err) {
        console.error("[footer] Workflow start handler error:", err);
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.WORKFLOW_END, (event: unknown) => {
      try {
        registry.updateData("workflow", { ...(event as Record<string, unknown>), active: false });
      } catch (err) {
        console.error("[footer] Workflow end handler error:", err);
      }
    })
  );

  // ─── Notification events ───────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.NOTIFICATION_SENT, (event: unknown) => {
      try {
        registry.updateData("notify", event);
      } catch (err) {
        console.error("[footer] Notification handler error:", err);
      }
    })
  );

  // ─── Module ready events ───────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MODULE_READY, (_event: unknown) => {
      try {
        // Invalidate all caches when new modules load — they may bring fresh data
        registry.invalidateAll();
      } catch (err) {
        console.error("[footer] Module ready handler error:", err);
      }
    })
  );

  // Return composite unsubscribe function
  return () => {
    for (const unsub of unsubscribers) {
      try {
        unsub();
      } catch {
        // Ignore cleanup errors
      }
    }
  };
}
