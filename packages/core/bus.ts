/**
 * @pi-unipi/core — central typed event bus
 *
 * One channel for cross-module state and notifications, replacing the parallel
 * Symbol.for "shared holder" pattern (pull-only) and raw pi.events emissions
 * (emit-only, no replay). Sticky keys keep their last payload so late
 * subscribers (e.g. a footer loading after its publisher) replay it
 * immediately. Listeners registered through a pi are auto-removed on that
 * pi's session_shutdown together with ALL sticky state, so nothing leaks into
 * the next session (publishers republish on session_start).
 *
 * The singleton lives on globalThis under Symbol.for("unipi.bus") because core
 * can be loaded as multiple copies (umbrella bundle + standalone packages);
 * all copies must share one bus. No bus function ever throws.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  UNIPI_EVENTS,
  type UnipiAskUserPromptEvent,
  type UnipiMcpCatalogSyncedEvent,
  type UnipiCompactionEvent,
  type UnipiCompactorStatsEvent,
  type UnipiInfoDataEvent,
  type UnipiMemoryConsolidatedEvent,
  type UnipiMemoryDeletedEvent,
  type UnipiMemoryStoredEvent,
  type UnipiMcpServerEvent,
  type UnipiMcpToolsEvent,
  type UnipiModuleEvent,
  type UnipiNotificationSentEvent,
  type UnipiRalphIterationEvent,
  type UnipiRalphLoopEvent,
  type UnipiUpdateAppliedEvent,
  type UnipiUpdateAvailableEvent,
  type UnipiUpdateCheckEvent,
  type UnipiUpdateErrorEvent,
  type UnipiWorkflowEvent,
} from "./events.js";

export interface LhStateEvent {
  /** Display mode id: active owner's mode, else last resolved turn mode / session default. "none" = regular. */
  mode: string;
  /** Mode id of a parked owner, when one exists (footer shows "<Mode> · paused" while mode === "none"). */
  paused?: string;
  owner?: { kind: string; status: "active" | "parked" };
  lastStop?: { kind: "complete" | "paused" | "budget" | "other"; at: number };
}

export interface KanboardStatusEvent {
  claims: string[];
  autowork: boolean;
}

export interface WorkflowStatusEvent {
  planMode: boolean;
  permissionMode: string | null;
}

/** Fusion lead/sidekick display status (moved from fusion-status.ts SharedFusionStatus). */
export interface FusionStatusEvent {
  /** Display name of the lead (the session model). */
  leadName: string;
  /** Lead model key provider/id (for child-model resolution). */
  leadKey?: string;
  /** Sidekick model key provider/id (for child-model resolution). */
  sidekickKey?: string;
  /** Lead thinking level, e.g. "medium". */
  leadEffort: string;
  /** Display name of the sidekick. */
  sidekickName: string;
  /** Sidekick thinking level. */
  sidekickEffort: string;
  /** Estimated savings compared with pricing all sidekick usage at lead rates. */
  savedUsd?: number;
  /** A handoff is running on the sidekick right now. */
  busy?: boolean;
  /** Tool calls made directly by the lead in this session while Fusion was active. */
  leadToolCalls?: number;
  /** Tool calls made by the sidekick across all handoffs (completed + in flight). */
  sidekickToolCalls?: number;
}

/** Payload per UNIPI_EVENTS key. Sticky keys carry display state; the rest are one-shot. */
export interface UnipiEventMap {
  // Sticky state
  [UNIPI_EVENTS.LH_STATE]: LhStateEvent;
  [UNIPI_EVENTS.KANBOARD_STATUS]: KanboardStatusEvent;
  /** undefined = cleared */
  [UNIPI_EVENTS.FUSION_STATUS]: FusionStatusEvent | undefined;
  [UNIPI_EVENTS.WORKFLOW_STATUS]: WorkflowStatusEvent;

  // One-shot
  [UNIPI_EVENTS.MODULE_READY]: UnipiModuleEvent;
  [UNIPI_EVENTS.WORKFLOW_START]: UnipiWorkflowEvent;
  [UNIPI_EVENTS.WORKFLOW_END]: UnipiWorkflowEvent;
  [UNIPI_EVENTS.PERMISSION_MODE_CHANGED]: unknown;
  [UNIPI_EVENTS.PLAN_MODE_CHANGED]: unknown;
  [UNIPI_EVENTS.RALPH_LOOP_START]: UnipiRalphLoopEvent;
  [UNIPI_EVENTS.RALPH_LOOP_END]: UnipiRalphLoopEvent;
  [UNIPI_EVENTS.RALPH_ITERATION_DONE]: UnipiRalphIterationEvent;
  [UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED]: unknown;
  [UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED]: unknown;
  [UNIPI_EVENTS.LONG_HORIZON_TODO_UPDATED]: unknown;
  [UNIPI_EVENTS.INFO_DATA_UPDATED]: UnipiInfoDataEvent;
  [UNIPI_EVENTS.MEMORY_STORED]: UnipiMemoryStoredEvent;
  [UNIPI_EVENTS.MEMORY_DELETED]: UnipiMemoryDeletedEvent;
  [UNIPI_EVENTS.MEMORY_CONSOLIDATED]: UnipiMemoryConsolidatedEvent;
  [UNIPI_EVENTS.MCP_SERVER_STARTED]: UnipiMcpServerEvent;
  [UNIPI_EVENTS.MCP_SERVER_STOPPED]: UnipiMcpServerEvent;
  [UNIPI_EVENTS.MCP_SERVER_ERROR]: UnipiMcpServerEvent;
  [UNIPI_EVENTS.MCP_TOOLS_REGISTERED]: UnipiMcpToolsEvent;
  [UNIPI_EVENTS.MCP_TOOLS_UNREGISTERED]: UnipiMcpToolsEvent;
  [UNIPI_EVENTS.MCP_CATALOG_SYNCED]: UnipiMcpCatalogSyncedEvent;
  [UNIPI_EVENTS.COMPACTOR_COMPACTED]: UnipiCompactionEvent;
  [UNIPI_EVENTS.COMPACTOR_STATS_UPDATED]: UnipiCompactorStatsEvent;
  [UNIPI_EVENTS.NOTIFICATION_SENT]: UnipiNotificationSentEvent;
  [UNIPI_EVENTS.ASK_USER_PROMPT]: UnipiAskUserPromptEvent;
  [UNIPI_EVENTS.UPDATE_CHECK]: UnipiUpdateCheckEvent;
  [UNIPI_EVENTS.UPDATE_AVAILABLE]: UnipiUpdateAvailableEvent;
  [UNIPI_EVENTS.UPDATE_APPLIED]: UnipiUpdateAppliedEvent;
  [UNIPI_EVENTS.UPDATE_ERROR]: UnipiUpdateErrorEvent;
  [UNIPI_EVENTS.SKILLS_REVEAL]: { names: string[]; ctx?: unknown };
}

export type UnipiEventName = keyof UnipiEventMap;

/** Sticky state keys (bus keeps last value; new subscribers get it immediately). */
export const STICKY_EVENTS: ReadonlySet<UnipiEventName> = new Set<UnipiEventName>([
  UNIPI_EVENTS.LH_STATE,
  UNIPI_EVENTS.KANBOARD_STATUS,
  UNIPI_EVENTS.FUSION_STATUS,
  UNIPI_EVENTS.WORKFLOW_STATUS,
]);

const ALL_EVENT_NAMES: ReadonlySet<string> = new Set<string>(Object.values(UNIPI_EVENTS));

export function isUnipiEventName(name: string): name is UnipiEventName {
  return ALL_EVENT_NAMES.has(name);
}

const BUS_KEY = Symbol.for("unipi.bus");

interface BusHolder {
  listeners: Map<string, Set<(payload: unknown) => void>>;
  sticky: Map<string, unknown>;
  seenPis: WeakSet<object>;
  /** Listeners per subscribing pi (shared across core copies, like seenPis). */
  perPi: WeakMap<object, Set<{ key: string; fn: (payload: unknown) => void }>>;
}

function holder(): BusHolder {
  const g = globalThis as typeof globalThis & { [BUS_KEY]?: BusHolder };
  g[BUS_KEY] ??= { listeners: new Map(), sticky: new Map(), seenPis: new WeakSet(), perPi: new WeakMap() };
  return g[BUS_KEY] as BusHolder;
}

function removeListener(h: BusHolder, key: string, fn: (payload: unknown) => void): void {
  const set = h.listeners.get(key);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) h.listeners.delete(key);
}

export const bus: {
  emit<K extends UnipiEventName>(key: K, payload: UnipiEventMap[K]): void;
  /** Sticky keys only: last stored value (or undefined if never emitted). One-shot keys are always undefined. */
  get<K extends UnipiEventName>(key: K): UnipiEventMap[K] | undefined;
  /** Subscribe. Sticky keys with a stored value call fn synchronously once (replay) before returning.
   *  Listener auto-removed on the given pi's session_shutdown. Returns unsubscribe. */
  on<K extends UnipiEventName>(pi: Pick<ExtensionAPI, "on">, key: K, fn: (payload: UnipiEventMap[K]) => void): () => void;
} = {
  emit<K extends UnipiEventName>(key: K, payload: UnipiEventMap[K]): void {
    try {
      const h = holder();
      if (STICKY_EVENTS.has(key)) h.sticky.set(key, payload);
      const set = h.listeners.get(key);
      if (!set) return;
      // Snapshot: a listener may unsubscribe (itself or others) during emit.
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch {
          // A throwing listener never stops others and never throws out of emit.
        }
      }
    } catch {
      // Never throw from emit.
    }
  },

  get<K extends UnipiEventName>(key: K): UnipiEventMap[K] | undefined {
    try {
      return holder().sticky.get(key) as UnipiEventMap[K] | undefined;
    } catch {
      return undefined;
    }
  },

  on<K extends UnipiEventName>(pi: Pick<ExtensionAPI, "on">, key: K, fn: (payload: UnipiEventMap[K]) => void): () => void {
    try {
      const h = holder();
      const wrapped = fn as (payload: unknown) => void;
      const record = { key, fn: wrapped };
      let records = h.perPi.get(pi);
      if (!records) {
        records = new Set();
        h.perPi.set(pi, records);
      }
      if (!h.seenPis.has(pi)) {
        h.seenPis.add(pi);
        try {
          pi.on("session_shutdown", () => {
            try {
              const hh = holder();
              for (const rec of hh.perPi.get(pi) ?? []) {
                removeListener(hh, rec.key, rec.fn);
              }
              hh.perPi.delete(pi);
              // Stale state must not leak into the next session;
              // publishers republish on session_start.
              hh.sticky.clear();
            } catch {
              // Never throw from the shutdown handler.
            }
          });
        } catch {
          // Frozen or minimal test hosts: skip lifecycle wiring.
        }
      }
      records.add(record);

      if (STICKY_EVENTS.has(key) && h.sticky.has(key)) {
        try {
          fn(h.sticky.get(key) as UnipiEventMap[K]);
        } catch {
          // A throwing listener never throws out of on().
        }
      }

      let set = h.listeners.get(key);
      if (!set) {
        set = new Set();
        h.listeners.set(key, set);
      }
      set.add(wrapped);

      return () => {
        try {
          const hh = holder();
          removeListener(hh, key, wrapped);
          hh.perPi.get(pi)?.delete(record);
        } catch {
          // Never throw from unsubscribe.
        }
      };
    } catch {
      return () => {};
    }
  },
};

/** Fresh bus state for tests (clears listeners, sticky values, and pi bookkeeping). */
export function resetBusForTests(): void {
  try {
    const g = globalThis as typeof globalThis & { [BUS_KEY]?: BusHolder };
    g[BUS_KEY] = undefined;
  } catch {
    // Never throw.
  }
}
