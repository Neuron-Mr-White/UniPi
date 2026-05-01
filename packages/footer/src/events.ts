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
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.COMPACTOR_COMPACTED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("compactor") as Record<string, unknown> | undefined;
        registry.updateData("compactor", { ...existing, lastCompaction: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  // ─── Memory events ─────────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MEMORY_STORED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("memory") as Record<string, unknown> | undefined;
        registry.updateData("memory", { ...existing, lastStored: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MEMORY_DELETED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("memory") as Record<string, unknown> | undefined;
        registry.updateData("memory", { ...existing, lastDeleted: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MEMORY_CONSOLIDATED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("memory") as Record<string, unknown> | undefined;
        registry.updateData("memory", { ...existing, lastConsolidated: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  // ─── MCP events ────────────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_SERVER_STARTED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        const evt = event as Record<string, unknown> | undefined;
        const toolCount = typeof evt?.toolCount === "number" ? evt.toolCount : 0;
        const serversTotal = (typeof existing?.serversTotal === "number" ? existing.serversTotal : 0) + 1;
        const serversActive = (typeof existing?.serversActive === "number" ? existing.serversActive : 0) + 1;
        const toolsTotal = (typeof existing?.toolsTotal === "number" ? existing.toolsTotal : 0) + toolCount;
        registry.updateData("mcp", { ...existing, serversTotal, serversActive, toolsTotal, lastServerStarted: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_SERVER_STOPPED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        const evt = event as Record<string, unknown> | undefined;
        const stoppedName = typeof evt?.name === "string" ? evt.name : "";
        const serversActive = Math.max(0, (typeof existing?.serversActive === "number" ? existing.serversActive : 1) - 1);
        // Subtract tools for this server if tracked
        const lastStartedTools = existing?.lastServerStarted as Record<string, unknown> | undefined;
        const lastStartedName = typeof lastStartedTools?.name === "string" ? lastStartedTools.name : "";
        const lastStartedCount = typeof lastStartedTools?.toolCount === "number" ? lastStartedTools.toolCount : 0;
        let toolsTotal = typeof existing?.toolsTotal === "number" ? existing.toolsTotal : 0;
        if (stoppedName && stoppedName === lastStartedName) {
          toolsTotal = Math.max(0, toolsTotal - lastStartedCount);
        }
        registry.updateData("mcp", { ...existing, serversActive, toolsTotal, lastServerStopped: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_SERVER_ERROR, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        const serversTotal = (typeof existing?.serversTotal === "number" ? existing.serversTotal : 0) + 1;
        const serversFailed = (typeof existing?.serversFailed === "number" ? existing.serversFailed : 0) + 1;
        registry.updateData("mcp", { ...existing, serversTotal, serversFailed, lastServerError: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_TOOLS_REGISTERED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        const evt = event as Record<string, unknown> | undefined;
        const toolNames = Array.isArray(evt?.toolNames) ? evt.toolNames : [];
        const toolsTotal = (typeof existing?.toolsTotal === "number" ? existing.toolsTotal : 0) + toolNames.length;
        registry.updateData("mcp", { ...existing, toolsTotal, lastToolsRegistered: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MCP_TOOLS_UNREGISTERED, (event: unknown) => {
      try {
        const existing = registry.getGroupData("mcp") as Record<string, unknown> | undefined;
        const evt = event as Record<string, unknown> | undefined;
        const toolNames = Array.isArray(evt?.toolNames) ? evt.toolNames : [];
        const toolsTotal = Math.max(0, (typeof existing?.toolsTotal === "number" ? existing.toolsTotal : 0) - toolNames.length);
        registry.updateData("mcp", { ...existing, toolsTotal, lastToolsUnregistered: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  // ─── Ralph events ──────────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.RALPH_LOOP_START, (event: unknown) => {
      try {
        registry.updateData("ralph", { ...(event as Record<string, unknown>), active: true });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.RALPH_LOOP_END, (event: unknown) => {
      try {
        registry.updateData("ralph", { ...(event as Record<string, unknown>), active: false });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.RALPH_ITERATION_DONE, (event: unknown) => {
      try {
        const existing = registry.getGroupData("ralph") as Record<string, unknown> | undefined;
        registry.updateData("ralph", { ...existing, lastIteration: event });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  // ─── Workflow events ───────────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.WORKFLOW_START, (event: unknown) => {
      try {
        registry.updateData("workflow", { ...(event as Record<string, unknown>), active: true, startTime: Date.now() });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.WORKFLOW_END, (event: unknown) => {
      try {
        registry.updateData("workflow", { ...(event as Record<string, unknown>), active: false });
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  // ─── Notification events ───────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.NOTIFICATION_SENT, (event: unknown) => {
      try {
        registry.updateData("notify", event);
      } catch {
        // Silently ignore — event handler errors are non-blocking.
      }
    })
  );

  // ─── Module ready events ───────────────────────────────────────────────

  unsubscribers.push(
    pi.events.on(UNIPI_EVENTS.MODULE_READY, (_event: unknown) => {
      try {
        // Invalidate all caches when new modules load — they may bring fresh data
        registry.invalidateAll();
      } catch {
        // Silently ignore — event handler errors are non-blocking.
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
