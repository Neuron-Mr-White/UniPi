/**
 * @pi-unipi/footer — Event subscription wiring
 *
 * The glance frame reads mode/permission state from core's shared holders
 * (getShared* helpers). These handlers feed the registry's "core" data as the
 * FALLBACK for when a shared holder has no value yet (e.g. before the
 * workflow module re-emits on resume).
 *
 * Note: pi.events.on() returns an unsubscribe function directly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UNIPI_EVENTS } from "@pi-unipi/core";
import type { FooterRegistry } from "./registry/index.js";

/** Cleanup function returned by subscribeToEvents */
type UnsubscribeFn = () => void;

function updateCoreData(registry: FooterRegistry, patch: Record<string, unknown>): void {
  const existing = registry.getGroupData("core") as Record<string, unknown> | undefined;
  registry.updateData("core", { ...existing, ...patch });
}

/**
 * Subscribe to the UNIPI_EVENTS the glance frame still consumes.
 * Returns an unsubscribe function for cleanup on session shutdown.
 */
export function subscribeToEvents(
  pi: ExtensionAPI,
  registry: FooterRegistry,
): UnsubscribeFn {
  const unsubscribers: UnsubscribeFn[] = [];

  const on = (event: string, handler: (data: unknown) => void) => {
    unsubscribers.push(pi.events.on(event, handler));
  };

  // ─── Plan mode / permission mode (workflow) ─────────────────────────────

  on(UNIPI_EVENTS.PLAN_MODE_CHANGED, (event: unknown) => {
    try {
      const active = (event as { active?: boolean })?.active === true;
      updateCoreData(registry, { planMode: active });
    } catch {
      // Silently ignore — event handler errors are non-blocking.
    }
  });

  on(UNIPI_EVENTS.PERMISSION_MODE_CHANGED, (event: unknown) => {
    try {
      const mode = (event as { mode?: string })?.mode;
      if (typeof mode === "string" && mode.length > 0) {
        updateCoreData(registry, { permissionMode: mode });
      }
    } catch {
      // Silently ignore — event handler errors are non-blocking.
    }
  });

  // ─── Long-horizon mode ──────────────────────────────────────────────────

  on(UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED, (event: unknown) => {
    try {
      const mode = (event as { mode?: string })?.mode;
      if (typeof mode === "string" && mode.length > 0) {
        updateCoreData(registry, { lhMode: mode });
      }
    } catch {
      // Silently ignore — event handler errors are non-blocking.
    }
  });

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
