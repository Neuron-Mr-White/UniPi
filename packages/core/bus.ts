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
  type UnipiCompactionEvent,
  type UnipiLhModeResolvedEvent,
  type UnipiLhOwnerChangedEvent,
  type UnipiMemoryDeletedEvent,
  type UnipiMemoryStoredEvent,
  type UnipiMcpServerEvent,
  type UnipiMcpToolsEvent,
  type UnipiModuleEvent,
  type UnipiNotificationSentEvent,
  type UnipiPlanModeEvent,
  type UnipiPermissionModeEvent,
  type UnipiRalphIterationEvent,
  type UnipiRalphLoopEvent,
  type UnipiUpdateAppliedEvent,
  type UnipiUpdateAvailableEvent,
  type UnipiUpdateCheckEvent,
} from "./events.js";

export interface LhStateEvent {
  /** Display mode id: active owner's mode, else last resolved turn mode / session default. "none" = regular. */
  mode: string;
  /** Mode id of a parked owner, when one exists (footer shows "<Mode> · paused" while mode === "none"). */
  paused?: string;
  owner?: { kind: string; status: "active" | "parked" };
  lastStop?: { kind: "complete" | "paused" | "budget" | "other"; at: number };
}

/** One work item of a long-horizon run (graph/swarm item or ralph checklist row), UI-shaped (UNI-222). */
export interface LhProgressItem {
  id: string;
  /** Short human label (graph/swarm instruction or checklist text), clipped. */
  label: string;
  status: "queued" | "ready" | "running" | "done" | "failed" | "aborted";
  /** Graph: ids this item consumes. Empty elsewhere. */
  deps: string[];
  /** Graph: topological level (0 = roots). */
  wave?: number;
  /** The committed result / failure note, clipped. */
  summary?: string;
  attempts?: number;
}

/** One long-horizon run (the current one or the last finished one). */
export interface LhProgressRun {
  mode: "goal" | "ralph" | "swarm" | "graph";
  /** Goal objective, loop name, swarm/graph task. */
  title: string;
  status: "running" | "paused" | "done" | "failed" | "stopped";
  /** Terminal / pause reason, e.g. `settled(with_failures)`. */
  reason?: string;
  items: LhProgressItem[];
  counts: { total: number; done: number; running: number; failed: number; queued: number };
  ralph?: { name: string; iteration: number; maxIterations: number; checked: number; total: number };
  goal?: { objective: string; status: string; turn: number; maxTurns: number; percent?: number; summary?: string; estimatedAt?: number };
  endedAt?: number;
}

/** One line of the shared progress log, generated from state transitions (never hand-written). */
export interface LhProgressLogLine {
  at: number;
  text: string;
  /** Item id the line is about, when any. */
  item?: string;
  /** The status the line reports (colours the line like the item's box). */
  status?: LhProgressItem["status"] | LhProgressRun["status"];
}

/** LH_PROGRESS payload: the one truth for the TUI view and the app's Progress sheet (UNI-222). */
export interface LhProgressEvent {
  v: 1;
  /** Mode of the current run, or "none" when nothing runs. */
  mode: "goal" | "ralph" | "swarm" | "graph" | "none";
  current?: LhProgressRun;
  /** The last finished run (shown when idle). */
  last?: LhProgressRun;
  /** Newest last, bounded. */
  log: LhProgressLogLine[];
  updatedAt: number;
}

export interface KanboardStatusEvent {
  claims: string[];
  autowork: boolean;
  /** Full CLI prefix for board writes: `<binary> --actor agent --project <slug>`. */
  cli?: string;
}

export interface WorkflowStatusEvent {
  planMode: boolean;
  permissionMode: string | null;
}

/** Fusion lead/sidekick display status (replaces the old pull-only fusion holder). */
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
  [UNIPI_EVENTS.LH_PROGRESS]: LhProgressEvent;
  [UNIPI_EVENTS.KANBOARD_STATUS]: KanboardStatusEvent;
  /** undefined = cleared */
  [UNIPI_EVENTS.FUSION_STATUS]: FusionStatusEvent | undefined;
  [UNIPI_EVENTS.WORKFLOW_STATUS]: WorkflowStatusEvent;

  // One-shot
  [UNIPI_EVENTS.MODULE_READY]: UnipiModuleEvent;
  [UNIPI_EVENTS.PERMISSION_MODE_CHANGED]: UnipiPermissionModeEvent;
  [UNIPI_EVENTS.PLAN_MODE_CHANGED]: UnipiPlanModeEvent;
  [UNIPI_EVENTS.RALPH_LOOP_END]: UnipiRalphLoopEvent;
  [UNIPI_EVENTS.RALPH_ITERATION_DONE]: UnipiRalphIterationEvent;
  [UNIPI_EVENTS.LONG_HORIZON_MODE_RESOLVED]: UnipiLhModeResolvedEvent;
  [UNIPI_EVENTS.LONG_HORIZON_OWNER_CHANGED]: UnipiLhOwnerChangedEvent;
  [UNIPI_EVENTS.MEMORY_STORED]: UnipiMemoryStoredEvent;
  [UNIPI_EVENTS.MEMORY_DELETED]: UnipiMemoryDeletedEvent;
  [UNIPI_EVENTS.MCP_SERVER_STARTED]: UnipiMcpServerEvent;
  [UNIPI_EVENTS.MCP_SERVER_ERROR]: UnipiMcpServerEvent;
  [UNIPI_EVENTS.MCP_TOOLS_REGISTERED]: UnipiMcpToolsEvent;
  [UNIPI_EVENTS.COMPACTOR_COMPACTED]: UnipiCompactionEvent;
  [UNIPI_EVENTS.NOTIFICATION_SENT]: UnipiNotificationSentEvent;
  [UNIPI_EVENTS.ASK_USER_PROMPT]: UnipiAskUserPromptEvent;
  [UNIPI_EVENTS.UPDATE_CHECK]: UnipiUpdateCheckEvent;
  [UNIPI_EVENTS.UPDATE_AVAILABLE]: UnipiUpdateAvailableEvent;
  [UNIPI_EVENTS.UPDATE_APPLIED]: UnipiUpdateAppliedEvent;
  [UNIPI_EVENTS.SKILLS_REVEAL]: { names: string[]; ctx?: unknown };
}

export type UnipiEventName = keyof UnipiEventMap;

/** Sticky state keys (bus keeps last value; new subscribers get it immediately). */
export const STICKY_EVENTS: ReadonlySet<UnipiEventName> = new Set<UnipiEventName>([
  UNIPI_EVENTS.LH_STATE,
  UNIPI_EVENTS.LH_PROGRESS,
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
