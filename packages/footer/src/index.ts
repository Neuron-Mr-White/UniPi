/**
 * @pi-unipi/footer — Extension entry point
 *
 * Registers commands, wires the TPS streaming hooks, installs the glance
 * editor + widgets on session_start, and runs the 1s incremental branch scan
 * that feeds the tracker and the strip snapshot.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  UNIPI_EVENTS,
  STICKY_EVENTS,
  bus,
  UNIPI_PREFIX,
  FOOTER_COMMANDS,
  getPackageVersion,
  findPackageRoot,
} from "@pi-unipi/core";
import { getFooterRegistry, type FooterRegistry } from "./registry/index.js";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { registerCommands } from "./commands.js";
import { GlanceEditor } from "./glance-editor.js";
import type { GlanceStatus } from "./glance-editor.js";
import { tpsTracker } from "./tps-tracker.js";
import { publishSharedTps } from "./tps-shared.js";
import { renderProcessLine, countBgProcesses } from "./process-line.js";
import { lhModeLabel } from "./segments/long-horizon.js";
import { SessionScanner } from "./session-scan.js";
import { renderSessionStrip, stripVisibleAtRows } from "./strip.js";
import { setIconStyle } from "./rendering/icons.js";

publishSharedTps();

/** Package version (from this package's package.json). */
const VERSION = getPackageVersion(
  findPackageRoot(dirname(fileURLToPath(import.meta.url)), "@pi-unipi/footer") ?? dirname(fileURLToPath(import.meta.url)),
);

/** Extension state */
export interface FooterState {
  enabled: boolean;
  registry: FooterRegistry;
  piContext: unknown;
  footerData: unknown;
  tuiRef: TUI | null | undefined;
  refreshTimer: ReturnType<typeof setInterval> | null;
  /** Glance-style editor component installed */
  glanceInstalled: boolean;
  /** Deferred install timer (focus-safety deferral past the boot overlay) */
  glanceInstallTimer: ReturnType<typeof setTimeout> | null;
  /** Bus sticky-state subscriptions (requestRender on change); re-created per session. */
  busUnsubs: Array<() => void>;
  /** Incremental branch scanner (tracker feeding + strip snapshot). */
  scanner: SessionScanner;
  /** Cheap key of everything the tick renders — requestRender only on change. */
  lastRenderKey: string;
  /** Background tool calls currently open (render-key input). */
  activeToolCalls: number;
  /** Re-register footer + widgets with pi UI (for live enable) */
  setupUI: ((pi: ExtensionAPI, ctx: ExtensionContext) => void) | null;
}

export default function footerExtension(pi: ExtensionAPI): void {
  // Create state
  const state: FooterState = {
    enabled: true,
    registry: getFooterRegistry(),
    piContext: null,
    footerData: null,
    tuiRef: null,
    refreshTimer: null,
    glanceInstalled: false,
    glanceInstallTimer: null,
    busUnsubs: [],
    scanner: new SessionScanner(),
    lastRenderKey: "",
    activeToolCalls: 0,
    setupUI: null,
  };

  // ─── TPS streaming-event hooks (registered once) ────────────────────────
  // pi.on() has no unsubscribe, so we register these exactly once at factory
  // time (not per session_start) to avoid duplicate handlers accumulating
  // across session restarts. The streamingIndex counter is reset on each
  // session_shutdown. These hooks feed the TPS tracker in real time; the 1s
  // incremental scan only reconciles persisted messages.
  wireTpsStreamingEvents(pi);

  // TTFT request boundary (harness semantics): turn_start = "agent started".
  // Stamps the pending record's requestAt so the first delta can measure
  // time-to-first-word from the moment the turn began.
  pi.on("turn_start", ((event: { timestamp?: number }) => {
    try { tpsTracker.onTurnStart(event?.timestamp); } catch { /* best-effort */ }
  }) as (event: unknown) => void);

  // Close the open turn when the agent fully settles (harness assistant/message
  // boundary ≈ agent_settled for wall-time purposes).
  pi.on("agent_settled", (() => {
    try { tpsTracker.onTurnEnd(); } catch { /* best-effort */ }
  }) as (event: unknown) => void);

  // Tool wall time: call → result pairs matched by callId.
  pi.on("tool_execution_start", ((event: { toolCallId?: string }) => {
    try {
      if (event?.toolCallId) {
        tpsTracker.onToolCallStart(event.toolCallId);
        state.activeToolCalls++;
      }
    } catch { /* best-effort */ }
  }) as (event: unknown) => void);
  pi.on("tool_execution_end", ((event: { toolCallId?: string }) => {
    try {
      if (event?.toolCallId) {
        tpsTracker.onToolCallEnd(event.toolCallId);
        state.activeToolCalls = Math.max(0, state.activeToolCalls - 1);
      }
    } catch { /* best-effort */ }
  }) as (event: unknown) => void);

  // ─── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const settings = loadFooterSettings();
    state.enabled = settings.enabled;
    state.piContext = ctx;
    setIconStyle(settings.iconStyle);

    // Announce the module regardless of UI availability.
    bus.emit(UNIPI_EVENTS.MODULE_READY, {
      name: "@pi-unipi/footer",
      version: VERSION,
      commands: [`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER}`],
      tools: [],
    });

    if (!settings.enabled || !ctx.hasUI) return;

    // Glance frame data now rides the bus's sticky state; request a render
    // whenever a publisher updates any of the four sticky keys. One set of
    // subscriptions per session: drop the previous set before re-subscribing
    // (session_start can fire again on the same pi; the bus also auto-removes
    // these on session_shutdown).
    for (const unsub of state.busUnsubs.splice(0)) unsub();
    state.busUnsubs = [...STICKY_EVENTS].map((key) =>
      bus.on(pi, key, () => (state.tuiRef as { requestRender?: () => void } | null | undefined)?.requestRender?.()),
    );

    // Glance-style input surface (pi-glance-inspired). Preserves all default
    // editor behavior via CustomEditor subclassing; only paint differs.
    //
    // FOCUS-SAFETY DEFERRAL: the timer remains a grace period for the boot
    // dashboard, but installGlanceEditor also restores any overlay focus after
    // setEditorComponent() calls ui.setFocus(newEditor). This covers the
    // updater prompt too, so q/Esc cannot be stranded in the editor.
    state.glanceInstallTimer = setTimeout(() => installGlanceEditor(state, ctx), 3500);

    // Sync TPS cursor with persisted assistant messages so streaming-hook
    // indexes match the scan's branch-local indexes, then take the first
    // (full) scan so the strip has data before the first tick.
    tpsTracker.reset();
    resetTpsStreamingIndex();
    cursorSyncCount(ctx);
    fullRescan(state);

    // Setup footer + widgets
    setupFooterUI(pi, ctx, state);
    state.setupUI = (p: ExtensionAPI, c: ExtensionContext) => setupFooterUI(p, c, state);
  });

  pi.on("session_shutdown", async () => {
    if (state.glanceInstallTimer) {
      clearTimeout(state.glanceInstallTimer);
      state.glanceInstallTimer = null;
    }
    for (const unsub of state.busUnsubs.splice(0)) unsub();
    state.piContext = null;
    state.footerData = null;
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    state.tuiRef = null;
    state.lastRenderKey = "";
    tpsTracker.reset();
    resetTpsStreamingIndex();
  });

  // ─── Register commands ──────────────────────────────────────────────────

  registerCommands(pi, state);
}

// ─── Footer UI setup ────────────────────────────────────────────────────────

function setupFooterUI(pi: ExtensionAPI, ctx: ExtensionContext, state: FooterState): void {
  // Register footer (minimal — handles branch changes)
  ctx.ui.setFooter((tui, _theme, footerData) => {
    state.tuiRef = tui;

    // Periodic refresh for time-sensitive data (TPS, compaction age, bg
    // tasks). The scan is incremental: new branch entries only, with a full
    // rescan on branch change/compaction; requestRender fires only when the
    // rendered key changes.
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(() => {
        tickScan(state);
      }, 1_000);
    }
    state.footerData = footerData;

    const unsub = footerData.onBranchChange(() => {
      // Branch indexes are relative to the current branch. Drop all scan
      // state; the next tick (or the call below) rebuilds from scratch.
      fullRescan(state);
    });

    return {
      dispose: unsub,
      invalidate() {
        state.lastRenderKey = "";
      },
      render(): string[] {
        return [];
      },
    };
  });

  // Top row widget — the bg-process one-liner, rendered directly above the
  // glance frame (the frame replaces the editor, so this aboveEditor slot sits
  // right above the footer); the frame's own borders show
  // branch/context/model/thinking.
  ctx.ui.setWidget("footer-top", (tui, _theme) => {
    state.tuiRef = tui;
    return {
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        const settings = loadFooterSettings();
        if (!state.enabled || !settings.processLine || !state.piContext || width <= 0) return [];
        if (!stripVisibleAtRows(terminalRows(tui))) return [];
        return renderProcessLine(width);
      },
    };
  }, { placement: "aboveEditor" });

  // Secondary row widget — glance-style session strip
  ctx.ui.setWidget("footer-secondary", (tui, _theme) => {
    state.tuiRef = tui;
    return {
      dispose() {},
      invalidate() {},
      render(width: number): string[] {
        const settings = loadFooterSettings();
        if (!state.enabled || !state.piContext || width <= 0) return [];
        if (!stripVisibleAtRows(terminalRows(tui))) return [];
        return renderSessionStrip(settings, state.scanner.snapshot, state.piContext, width);
      },
    };
  }, { placement: "belowEditor" });
}

/** Terminal rows via pi-tui (undefined-safe → visible when unknown). */
function terminalRows(tui: TUI | null | undefined): number | undefined {
  try {
    const rows = (tui as unknown as { terminal?: { rows?: number } } | null | undefined)?.terminal?.rows;
    return typeof rows === "number" ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One 1s tick: feed new branch entries to the tracker/scanner (full reset+
 * rescan when the branch changed shape), then requestRender only when the
 * rendered key changed.
 */
function tickScan(state: FooterState): void {
  if (!state.enabled) return; // /unipi:footer off — nothing to scan or draw
  try {
    const piCtx = state.piContext as Record<string, unknown> | undefined;
    const sm = piCtx?.sessionManager as { getBranch?: () => unknown[] } | undefined;
    const events = sm?.getBranch?.() ?? [];
    if (state.scanner.needsFullRescan(events)) {
      fullRescan(state, events);
    } else {
      state.scanner.scan(events);
    }
  } catch {
    // Silently ignore — TPS/strip data is best-effort
  }
  requestRenderIfChanged(state);
}

/**
 * Drop all scan state and rebuild from the current branch: tracker reset,
 * streaming-hook cursor resync, fresh snapshot. Used on session_start,
 * branch change, compaction, and live re-enable. (Exported for commands.ts.)
 */
export function fullRescan(state: FooterState, events?: readonly unknown[]): void {
  try {
    const branch = events ?? (() => {
      const piCtx = state.piContext as Record<string, unknown> | undefined;
      const sm = piCtx?.sessionManager as { getBranch?: () => unknown[] } | undefined;
      return sm?.getBranch?.() ?? [];
    })();
    state.scanner.reset();
    tpsTracker.reset();
    resetTpsStreamingIndex();
    cursorSyncCount(state.piContext);
    state.scanner.scan(branch);
  } catch {
    // Silently ignore — TPS/strip data is best-effort
  }
  state.lastRenderKey = "";
}

/**
 * Cheap key over everything the tick displays. A tick only calls
 * requestRender() when this changes: snapshot sums, compaction age bucket,
 * streaming state, open tool calls, background-task counts.
 */
function renderKey(state: FooterState): string {
  const s = state.scanner.snapshot;
  const age = s.compactionLastAt != null
    ? Math.floor((Date.now() - s.compactionLastAt) / 60_000)
    : "";
  const bg = countBgProcesses();
  return [
    s.userCount,
    s.assistantCount,
    s.input,
    s.output,
    s.cost.toFixed(2),
    s.compactionCount,
    age,
    tpsTracker.isStreaming() ? "S" : "",
    state.activeToolCalls,
    bg ? `${bg.running}/${bg.stopped}/${bg.failed}/${bg.done}` : "",
    tpsTracker.getStepCount(),
    // Rainbow brand animates with wall time — keep the 1s shimmer when on.
    loadFooterSettings().rainbow !== "off" ? Math.floor(Date.now() / 1000) : "",
  ].join("|");
}

function requestRenderIfChanged(state: FooterState): void {
  const key = renderKey(state);
  if (key === state.lastRenderKey) return;
  state.lastRenderKey = key;
  state.tuiRef?.requestRender();
}

/**
 * Install the GlanceEditor via ctx.ui.setEditorComponent. Safe to call
 * repeatedly; no-ops when already installed, when the footer is disabled, or
 * without a UI. Failures fall back to pi's default input box.
 * (Exported for the glance-focus regression tests.)
 */
export function installGlanceEditor(
  st: FooterState,
  uiHost: { ui: { setEditorComponent(f: unknown): void } },
): void {
  if (st.glanceInstalled || !st.piContext || !st.enabled) return;
  try {
    const tui = st.tuiRef as (TUI & {
      isOverlayFocused?: () => boolean;
      getFocusedComponent?: () => import("@earendil-works/pi-tui").Component | null;
    }) | null | undefined;
    const overlayFocused = tui !== undefined && tui !== null
      && (typeof tui.isOverlayFocused === "function" ? tui.isOverlayFocused() : tui.hasOverlay());
    const overlayOwner = overlayFocused && typeof tui?.getFocusedComponent === "function"
      ? tui.getFocusedComponent() ?? null
      : null;
    const piCtx = st.piContext as Record<string, unknown> | undefined;
    const cwd = (piCtx?.sessionManager as any)?.getCwd?.() ?? (piCtx as any)?.cwd ?? process.cwd();
    const workspace = String(cwd).split("/").filter(Boolean).pop() ?? "~";
    uiHost.ui.setEditorComponent((tui: unknown, theme: unknown, keybindings: unknown) =>
      new GlanceEditor(tui as never, theme as never, keybindings as never, (): GlanceStatus => {
        const settings = loadFooterSettings();
        const p = st.piContext as Record<string, unknown> | undefined;
        const usage = typeof (p as any)?.getContextUsage === "function"
          ? (p as any).getContextUsage()
          : undefined;
        const model = p?.model as Record<string, unknown> | undefined;
        let modelName = (model?.name || model?.id || "") as string;
        if (modelName.startsWith("Claude ")) modelName = modelName.slice(7);
        const branch = (st.footerData as any)?.getGitBranch?.() ?? null;
        const fusion = bus.get(UNIPI_EVENTS.FUSION_STATUS) ?? null;
        const kanboard = bus.get(UNIPI_EVENTS.KANBOARD_STATUS) ?? null;
        // Plan/permission mode is one sticky snapshot published by workflow.
        const wf = bus.get(UNIPI_EVENTS.WORKFLOW_STATUS);
        return {
          workspace,
          lhMode: lhModeLabel(bus.get(UNIPI_EVENTS.LH_STATE)),
          planMode: wf?.planMode === true,
          permissionMode:
            typeof wf?.permissionMode === "string" && wf.permissionMode.length > 0 ? wf.permissionMode : null,
          branch: typeof branch === "string" ? branch : null,
          contextPct: typeof usage?.percent === "number" ? usage.percent : null,
          contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : 0,
          modelName,
          thinkingLevel: typeof p?.thinkingLevel === "string" ? p.thinkingLevel : null,
          fusion,
          kanboard,
          rainbow: settings.rainbow,
          badges: settings.badges,
        };
      }),
    );
    // setCustomEditorComponent detaches the previous editor, but any open
    // overlay captured it as its preFocus restore target — closing the overlay
    // would refocus a dead component and swallow all input. Right after the
    // swap, getFocusedComponent() is the new editor; retarget stale preFocus
    // entries to it (skip preFocus that points at a live overlay).
    const newEditor = typeof tui?.getFocusedComponent === "function" ? tui.getFocusedComponent() : null;
    const internals = tui as ({
      overlayStack?: Array<{ component?: unknown; preFocus?: unknown }>;
      isComponentMounted?: (c: unknown) => boolean;
    }) | null | undefined;
    const overlayStack = internals?.overlayStack;
    const isMounted = typeof internals?.isComponentMounted === "function"
      ? internals.isComponentMounted.bind(tui)
      : undefined;
    if (newEditor && overlayStack && isMounted) {
      const overlayComponents = new Set(overlayStack.map((entry) => entry.component));
      for (const entry of overlayStack) {
        if (entry.preFocus && entry.preFocus !== newEditor && !overlayComponents.has(entry.preFocus) && !isMounted(entry.preFocus)) {
          entry.preFocus = newEditor;
        }
      }
    }
    if (overlayOwner && tui) tui.setFocus(overlayOwner);
    st.glanceInstalled = true;
  } catch {
    st.glanceInstalled = false;
  }
}

// ─── TPS streaming-event hooks ──────────────────────────────────────────────

/**
 * Sequential index of the currently-streaming assistant message within the
 * session branch. Tracked locally because pi does not expose a stable message
 * index on streaming events, and the TPS tracker keys records off this index.
 *
 * Both the streaming hooks and the 1s reconciliation scan key records by the
 * same scheme: position among assistant messages in `getBranch()`. To stay in
 * sync, on session_start (and branch changes) we replay the count of persisted
 * assistant messages into this cursor BEFORE any new message_start fires.
 */
let tpsStreamingIndex = -1;

/** Reset the streaming index (called on session_shutdown). */
function resetTpsStreamingIndex(): void {
  tpsStreamingIndex = -1;
}

/**
 * Re-synchronize the streaming hook cursor with the session branch.
 *
 * Root cause of the frozen-TPS bug: this module's cursor starts at -1 for every
 * new session, while the 1s reconciliation scan seeds tracker records at
 * branch-local indexes 0..N-1. Until the cursor caught up past N, every
 * streaming event landed on an already-completed record and was ignored —
 * so live TPS froze at the last completed message for the first N messages of
 * each session (and drifted permanently once cursors diverged).
 *
 * Fix: on session_start, seed the cursor to N-1 (count of persisted assistant
 * messages minus one), so the NEXT message_start maps to branch-local index N,
 * exactly matching what the reconciliation scan will use. Also called when a
 * branch change is observed (compaction/branch switch), since indexes are
 * branch-relative.
 */
export function cursorSyncCount(piContext: unknown): void {
  try {
    const ctx = piContext as Record<string, unknown> | undefined;
    const sm = ctx?.sessionManager as { getBranch?: () => unknown[] } | undefined;
    const events = sm?.getBranch?.() ?? [];
    let assistantCount = 0;
    for (const e of events) {
      if (!e || typeof e !== "object") continue;
      const entry = e as Record<string, unknown>;
      if (entry.type !== "message") continue;
      const m = entry.message as Record<string, unknown> | undefined;
      if (!m || m.role !== "assistant") continue;
      const stopReason = m.stopReason as string | undefined;
      if (stopReason === "error" || stopReason === "aborted") continue;
      assistantCount++;
    }
    tpsStreamingIndex = assistantCount - 1;
  } catch {
    // Cursor sync is best-effort; streaming hooks tolerate being behind via
    // the reconciliation scan anyway.
  }
}

/**
 * Subscribe to pi's message streaming events and feed the TPS tracker in real
 * time. This complements the 1s scan in the refresh timer, which only sees
 * persisted (completed) messages. Without these hooks the tracker would never
 * observe an in-flight assistant message, so live TPS would stay frozen at the
 * last completed message's value.
 *
 * Registered once at extension-factory time (pi.on has no unsubscribe, so we
 * must not re-register per session_start or handlers would accumulate).
 */
function wireTpsStreamingEvents(pi: ExtensionAPI): void {
  const safe = (fn: () => void) => {
    try { fn(); } catch { /* TPS is best-effort */ }
  };

  pi.on("message_start", ((event: { message: unknown }) => safe(() => {
    const m = event.message as Record<string, unknown> | undefined;
    if (!m || m.role !== "assistant") return;
    if (m.stopReason === "error" || m.stopReason === "aborted") return;
    tpsStreamingIndex++;
    tpsTracker.onMessageStart(tpsStreamingIndex);
  })) as (event: unknown) => void);

  pi.on("message_update", ((event: { message: unknown; assistantMessageEvent?: { type?: string; delta?: string } }) => safe(() => {
    if (tpsStreamingIndex < 0) return;
    const m = event.message as Record<string, unknown> | undefined;
    if (!m || m.role !== "assistant") return;
    // Incremental deltas keep counting O(chunk); the clock starts on the
    // FIRST delta so time-to-first-token is excluded from the rate window.
    const ev = event.assistantMessageEvent;
    const type = ev?.type;
    if ((type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta") && typeof ev?.delta === "string") {
      tpsTracker.onStreamingDelta(tpsStreamingIndex, ev.delta);
    }
  })) as (event: unknown) => void);

  pi.on("message_end", ((event: { message: unknown }) => safe(() => {
    if (tpsStreamingIndex < 0) return;
    const m = event.message as Record<string, unknown> | undefined;
    if (!m || m.role !== "assistant") return;
    if (m.stopReason === "error" || m.stopReason === "aborted") return;
    // Anchor to exact provider usage.output at stream end.
    tpsTracker.onMessageEnd(tpsStreamingIndex, m);
  })) as (event: unknown) => void);
}
