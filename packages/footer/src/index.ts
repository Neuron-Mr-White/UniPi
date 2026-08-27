/**
 * @pi-unipi/footer — Extension entry point
 *
 * Main extension function that registers commands, subscribes to events,
 * initializes renderer on session_start.
 */

import type { ExtensionAPI, Theme, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { UNIPI_EVENTS, emitEvent, UNIPI_PREFIX, FOOTER_COMMANDS } from "@pi-unipi/core";
import { FooterRegistry, getFooterRegistry } from "./registry/index.js";
import { FooterRenderer } from "./rendering/renderer.js";
import { subscribeToEvents } from "./events.js";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { getPreset } from "./presets.js";
import { registerCommands } from "./commands.js";
import { GlanceEditor } from "./glance-editor.js";

// Import segment groups
import { CORE_SEGMENTS } from "./segments/core.js";
import { COMPACTOR_SEGMENTS } from "./segments/compactor.js";
import { MEMORY_SEGMENTS } from "./segments/memory.js";
import { MCP_SEGMENTS } from "./segments/mcp.js";
import { RALPH_SEGMENTS } from "./segments/ralph.js";
import { WORKFLOW_SEGMENTS } from "./segments/workflow.js";
import { KANBOARD_SEGMENTS } from "./segments/kanboard.js";
import { NOTIFY_SEGMENTS } from "./segments/notify.js";
import { STATUS_EXT_SEGMENTS } from "./segments/status-ext.js";

import type { FooterGroup, FooterSegment } from "./types.js";
import { tpsTracker } from "./tps-tracker.js";

/** All segment groups */
const ALL_GROUPS: FooterGroup[] = [
  { id: "core", name: "Core", segments: CORE_SEGMENTS, defaultShow: true },
  { id: "compactor", name: "Compactor", segments: COMPACTOR_SEGMENTS, defaultShow: true },
  { id: "memory", name: "Memory", segments: MEMORY_SEGMENTS, defaultShow: true },
  { id: "mcp", name: "MCP", segments: MCP_SEGMENTS, defaultShow: true },
  { id: "ralph", name: "Ralph", segments: RALPH_SEGMENTS, defaultShow: true },
  { id: "workflow", name: "Workflow", segments: WORKFLOW_SEGMENTS, defaultShow: true },
  { id: "kanboard", name: "Kanboard", segments: KANBOARD_SEGMENTS, defaultShow: true },
  { id: "notify", name: "Notify", segments: NOTIFY_SEGMENTS, defaultShow: false },
  { id: "status_ext", name: "Extensions", segments: STATUS_EXT_SEGMENTS, defaultShow: true },
];

/** Build a segment lookup from all groups */
function buildSegmentLookup(): Map<string, FooterSegment> {
  const map = new Map<string, FooterSegment>();
  for (const group of ALL_GROUPS) {
    for (const segment of group.segments) {
      map.set(segment.id, segment);
    }
  }
  return map;
}

/** Extension state */
export interface FooterState {
  enabled: boolean;
  registry: FooterRegistry;
  renderer: FooterRenderer;
  segmentLookup: Map<string, FooterSegment>;
  unsubscribeEvents: (() => void) | null;
  piContext: unknown;
  footerData: unknown;
  tuiRef: import("@earendil-works/pi-tui").TUI | null | undefined;
  refreshTimer: ReturnType<typeof setInterval> | null;
  /** Glance-style editor component installed */
  glanceInstalled: boolean;
  /** Glance experiment active (frame input + strip, classic row suppressed) */
  glanceMode: boolean;
  /** Deferred install timer (focus-safety deferral past the boot overlay) */
  glanceInstallTimer: ReturnType<typeof setTimeout> | null;
  /** Re-register footer + widgets with pi UI (for live enable) */
  setupUI: ((pi: ExtensionAPI, ctx: ExtensionContext) => void) | null;
}

export default function footerExtension(pi: ExtensionAPI): void {
  // Build segment lookup
  const segmentLookup = buildSegmentLookup();

  // Create state
  const state: FooterState = {
    enabled: true,
    registry: getFooterRegistry(),
    renderer: new FooterRenderer(
      getFooterRegistry(),
      { get: (id: string) => segmentLookup.get(id), allIds: () => Array.from(segmentLookup.keys()) },
      loadFooterSettings().preset,
    ),
    segmentLookup,
    unsubscribeEvents: null,
    piContext: null,
    footerData: null,
    tuiRef: null,
    refreshTimer: null,
    glanceInstalled: false,
    glanceMode: true,
    glanceInstallTimer: null,
    setupUI: null,
  };

  // Register all groups in the registry
  for (const group of ALL_GROUPS) {
    state.registry.registerGroup(group);
  }

  // ─── TPS streaming-event hooks (registered once) ────────────────────────
  // pi.on() has no unsubscribe, so we register these exactly once at factory
  // time (not per session_start) to avoid duplicate handlers accumulating
  // across session restarts. The streamingIndex counter is reset on each
  // session_shutdown. These hooks feed the TPS tracker in real time; the
  // 1s branch-scan in the refresh timer only reconciles persisted messages.
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
    try { if (event?.toolCallId) tpsTracker.onToolCallStart(event.toolCallId); } catch { /* best-effort */ }
  }) as (event: unknown) => void);
  pi.on("tool_execution_end", ((event: { toolCallId?: string }) => {
    try { if (event?.toolCallId) tpsTracker.onToolCallEnd(event.toolCallId); } catch { /* best-effort */ }
  }) as (event: unknown) => void);

  // ─── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const settings = loadFooterSettings();
    state.enabled = settings.enabled;
    state.glanceMode = settings.glanceMode !== false; // default ON
    state.piContext = ctx;
    state.renderer.setPreset(settings.preset);
    state.renderer.setActive(settings.enabled);

    if (!settings.enabled || !ctx.hasUI) return;

    // Subscribe to events
    state.unsubscribeEvents = subscribeToEvents(pi, state.registry);

    // Glance-style input surface (pi-glance-inspired). Preserves all default
    // editor behavior via CustomEditor subclassing; only paint differs.
    //
    // FOCUS-SAFETY DEFERRAL: setEditorComponent() internally calls
    // ui.setFocus(newEditor). info-screen (loaded before us) opens its boot
    // dashboard during ITS session_start handler, so our session_start runs
    // while that overlay owns keyboard focus. Swapping now would steal focus
    // and strand the dashboard unclosable (q/Esc would type into the editor).
    // The boot overlay auto-closes after ~2s; we install after a grace period
    // longer than any sane bootTimeoutMs.
    state.glanceInstallTimer = setTimeout(() => installGlanceEditor(state, ctx), 3500);

    // Sync TPS cursor with persisted assistant messages so streaming-hook
    // indexes match the reconciliation scan's branch-local indexes.
    tpsTracker.reset();
    resetTpsStreamingIndex();
    cursorSyncCount(ctx);

    // Setup footer + widgets
    setupFooterUI(pi, ctx, state);
    state.setupUI = (p: ExtensionAPI, c: ExtensionContext) => setupFooterUI(p, c, state);
  });

  pi.on("session_shutdown", async () => {
    state.renderer.setActive(false);
    if (state.glanceInstallTimer) {
      clearTimeout(state.glanceInstallTimer);
      state.glanceInstallTimer = null;
    }
    state.unsubscribeEvents?.();
    state.unsubscribeEvents = null;
    state.piContext = null;
    state.footerData = null;
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    state.tuiRef = null;
    tpsTracker.reset();
    resetTpsStreamingIndex();
  });

  // ─── Register commands ──────────────────────────────────────────────────

  registerCommands(pi, state, ALL_GROUPS);

  // ─── Emit MODULE_READY ──────────────────────────────────────────────────

  pi.on("session_start", async () => {
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: "@pi-unipi/footer",
      version: "0.1.0",
      commands: [`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER}`, `${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER_SETTINGS}`, `${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER_HELP}`],
      tools: [],
    });
  });
}

// ─── Footer UI setup ────────────────────────────────────────────────────────

function setupFooterUI(pi: ExtensionAPI, ctx: ExtensionContext, state: FooterState): void {
  // Register footer (minimal — handles branch changes)
  ctx.ui.setFooter((tui, _theme, footerData) => {
    state.tuiRef = tui;

    // Start periodic refresh for time-sensitive segments (e.g. clock, TPS)
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(() => {
        // Re-seed TPS tracker from the session branch on each tick.
        // Streaming events (message_start/update/end) handle live updates
        // in real time; this scan reconciles the tracker with persisted
        // messages after compactions, branch switches, or session reloads
        // where in-flight streaming state may have been lost.
        try {
          const piCtx = state.piContext as Record<string, unknown> | undefined;
          if (piCtx?.sessionManager) {
            const sm = (piCtx as any).sessionManager;
            const events = sm?.getBranch?.() ?? [];
            let msgIndex = 0;
            let userCount = 0;
            let firstAssistantTs = 0;
            let lastAssistantTs = 0;
            let prevAssistantTs = 0;
            // Branch-derived tool time: pending callId → assistant msg ts.
            const pendingToolCalls = new Map<string, number>();
            let branchToolMs = 0;
            // Per-assistant-message duration (this assistant ts → next entry
            // ts): the honest generation+tool window, replaces first-scan
            // reconstruction for restart tok/s.
            const recordDurations = new Map<number, number>();
            let prevEntryTs = 0;
            let prevAssistantIdx = -1;
            for (const e of events) {
              if (!e || typeof e !== "object") continue;
              if (e.type !== "message") continue;
              const m = e.message;
              if (!m) continue;
              // Branch-derived turn/wall accounting: user messages delimit
              // turns; assistant timestamps bound the session wall time.
              const ts = Date.parse((e as any).timestamp ?? "") || 0;
              // Close the previous assistant's window with this entry's ts.
              if (prevAssistantIdx >= 0 && ts > 0 && prevEntryTs > 0) {
                recordDurations.set(prevAssistantIdx, Math.min(ts - prevEntryTs, 600_000));
                prevAssistantIdx = -1;
              }
              if (ts > 0) prevEntryTs = ts;
              if (m.role === "user") {
                userCount++;
                continue;
              }
              if (m.role === "toolResult") {
                // Pair back to the assistant that issued this call.
                const callId = (m as any).toolCallId as string | undefined;
                if (callId && pendingToolCalls.has(callId)) {
                  const issuedAt = pendingToolCalls.get(callId)!;
                  pendingToolCalls.delete(callId);
                  if (ts > issuedAt) branchToolMs += Math.min(ts - issuedAt, 600_000);
                }
                continue;
              }
              if (m.role !== "assistant") continue;
              if (m.stopReason === "error" || m.stopReason === "aborted") continue;
              if (ts > 0) {
                if (firstAssistantTs === 0 || ts < firstAssistantTs) firstAssistantTs = ts;
                if (ts > lastAssistantTs) lastAssistantTs = ts;
                prevAssistantIdx = msgIndex; // close on next entry
              }
              const hasStop = !!m.stopReason;
              // Pass the whole message: completed messages get anchored to
              // exact provider usage.output; in-flight ones density-estimated.
              tpsTracker.onMessageUpdate(msgIndex, m, hasStop);
              // Register this message's tool calls for result pairing.
              // Block type is "toolCall" (capital C) in persisted sessions.
              const content = m.content as Array<{ type?: string; id?: string }> | undefined;
              if (Array.isArray(content)) {
                for (const block of content) {
                  const btype = String((block as any)?.type ?? "").toLowerCase();
                  const callId = (block as any)?.id;
                  if ((btype === "toolcall" || btype === "tool_use") && typeof callId === "string" && ts > 0) {
                    pendingToolCalls.set(callId, ts);
                  }
                }
              }
              // TTFT seed AFTER record creation: prev assistant ts ≈ request
              // bound, own ts ≈ first output. No-ops once hooks give samples.
              if (ts > 0) {
                tpsTracker.seedTtftFallback(prevAssistantTs, ts, msgIndex);
                prevAssistantTs = ts;
              }
              msgIndex++;
            }
            tpsTracker.syncBranchStats(userCount, msgIndex);
            if (recordDurations.size > 0) tpsTracker.syncRecordDurations(recordDurations);
            if (lastAssistantTs > firstAssistantTs) {
              tpsTracker.syncWallMs(lastAssistantTs - firstAssistantTs);
            }
            tpsTracker.syncToolMs(branchToolMs);
          }
        } catch {
          // Silently ignore — TPS is best-effort
        }
        state.renderer.resetLayoutCache();
        state.tuiRef?.requestRender();
      }, 1_000);
    }
    state.footerData = footerData;
    state.renderer.setContext(state.piContext, footerData);

    const unsub = footerData.onBranchChange(() => {
      // Branch indexes are relative to the current branch. Re-sync the TPS
      // hook cursor and rebuild tracker records for the new branch.
      tpsTracker.reset();
      resetTpsStreamingIndex();
      cursorSyncCount(state.piContext);
      state.renderer.resetLayoutCache();
    });

    return {
      dispose: unsub,
      invalidate() {
        state.renderer.resetLayoutCache();
      },
      render(): string[] {
        return [];
      },
    };
  });

  // Top row widget — classic status line (suppressed in glance mode; the
  // glance frame's top border already shows UNIPI │ branch and the bottom
  // border shows context/model/thinking, so a segment row would duplicate it)
  ctx.ui.setWidget("footer-top", (_tui, theme) => {
    // Update the renderer's theme-like
    const themeLike = { fg: (color: string, text: string) => theme.fg(color as any, text) };
    // We need to patch the context with proper theme
    state.renderer.setContext(state.piContext, state.footerData);

    return {
      dispose() {},
      invalidate() {
        state.renderer.resetLayoutCache();
      },
      render(width: number): string[] {
        if (!state.enabled || !state.piContext || width <= 0) return [];
        // Glance mode replaces the classic segment line entirely.
        if (state.glanceMode) return [];
        const layout = state.renderer.computeLayout(width);
        if (!layout.topContent) return [];

        // Hard safety net: never return a line wider than the terminal.
        // This catches any edge cases in layout math or visibleWidth()
        // inconsistencies with PUA characters + ANSI codes.
        const line = layout.topContent;
        return [visibleWidth(line) > width ? truncateToWidth(line, width) : line];
      },
    };
  }, { placement: "aboveEditor" });

  // Secondary row widget — glance-style session strip
  ctx.ui.setWidget("footer-secondary", (_tui, theme) => {
    return {
      dispose() {},
      invalidate() {
        state.renderer.resetLayoutCache();
      },
      render(width: number): string[] {
        if (!state.enabled || !state.glanceMode || !state.piContext || width <= 0) return [];
        const strip = renderSessionStrip(state.piContext);
        if (!strip) return [];
        // Centered under the input box.
        const w = visibleWidth(strip);
        if (w >= width) return [truncateToWidth(strip, width)];
        const leftPad = Math.floor((width - w) / 2);
        return [" ".repeat(leftPad) + strip];
      },
    };
  }, { placement: "belowEditor" });
}

/**
 * Install the GlanceEditor via ctx.ui.setEditorComponent. Safe to call
 * repeatedly; no-ops when already installed, when glance mode is off, or
 * without a UI. Failures fall back to pi's default input box.
 */
/**
 * Apply glanceMode live: install or remove the GlanceEditor and re-render.
 * Called from the settings overlay's onSettingsChanged callback. Removing
 * (setEditorComponent(undefined)) restores pi's default editor.
 */
export function applyGlanceMode(
  st: FooterState,
  cmdCtx: { ui: { setEditorComponent(f: never): void }; hasUI: boolean },
): void {
  if (!cmdCtx.hasUI) return;
  if (st.glanceInstallTimer) {
    clearTimeout(st.glanceInstallTimer);
    st.glanceInstallTimer = null;
  }
  if (st.glanceMode) {
    installGlanceEditor(st, cmdCtx);
  } else {
    try { cmdCtx.ui.setEditorComponent(undefined as never); } catch { /* already gone */ }
    st.glanceInstalled = false;
  }
  st.tuiRef?.requestRender();
}

function installGlanceEditor(
  st: FooterState,
  uiHost: { ui: { setEditorComponent(f: unknown): void } },
): void {
  if (st.glanceInstalled || !st.piContext || !st.glanceMode) return;
  try {
    const piCtx = st.piContext as Record<string, unknown> | undefined;
    const cwd = (piCtx?.sessionManager as any)?.getCwd?.() ?? (piCtx as any)?.cwd ?? process.cwd();
    const workspace = String(cwd).split("/").filter(Boolean).pop() ?? "~";
    uiHost.ui.setEditorComponent((tui: unknown, theme: unknown, keybindings: unknown) =>
      new GlanceEditor(tui as never, theme as never, keybindings as never, () => {
        const p = st.piContext as Record<string, unknown> | undefined;
        const usage = typeof (p as any)?.getContextUsage === "function"
          ? (p as any).getContextUsage()
          : undefined;
        const model = p?.model as Record<string, unknown> | undefined;
        let modelName = (model?.name || model?.id || "") as string;
        if (modelName.startsWith("Claude ")) modelName = modelName.slice(7);
        const branch = (st.footerData as any)?.getGitBranch?.() ?? null;
        return {
          workspace,
          branch: typeof branch === "string" ? branch : null,
          contextPct: typeof usage?.percent === "number" ? usage.percent : null,
          contextWindow: typeof usage?.contextWindow === "number" ? usage.contextWindow : 0,
          modelName,
          thinkingLevel: typeof p?.thinkingLevel === "string" ? p.thinkingLevel : null,
        };
      }),
    );
    st.glanceInstalled = true;
  } catch {
    st.glanceInstalled = false;
  }
}

// ─── Glance session strip ──────────────────────────────────────────────────

/** Format ms as stopwatch duration: 00:12 / 00:12:14 (mm:ss past 1h → h:mm:ss). */
function fmtWall(ms: number): string {
	if (ms < 1000) return "00:00";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Cache hit % from the session branch usage; null when no data. */
function cacheHitPct(piContext: unknown): number | null {
  try {
    let input = 0, cacheRead = 0, cacheWrite = 0;
    const sm = (piContext as Record<string, unknown>)?.sessionManager as any;
    for (const e of sm?.getBranch?.() ?? []) {
      const m = e?.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      input += m.usage.input ?? 0;
      cacheRead += m.usage.cacheRead ?? 0;
      cacheWrite += m.usage.cacheWrite ?? 0;
    }
    const denom = input + cacheRead + cacheWrite;
    if (denom <= 0) return null;
    return Math.round((cacheRead / denom) * 100);
  } catch {
    return null;
  }
}

/** Basic truecolor accents for strip numbers. */
const STRIP_COLOR = {
	count: "\x1b[96m", // cyan — turns/steps
	time: "\x1b[93m", // amber — wall · tool
	ttft: "\x1b[95m", // magenta — avg ttft
	psGood: "\x1b[92m", // green — ≥ 30 tok/s
	psSlow: "\x1b[91m", // red — < 10 tok/s
	psMid: "\x1b[97m", // white — in between
	cacheHit: "\x1b[92m", // green — high hit
	cacheWarn: "\x1b[93m", // amber — lowish hit
	reset: "\x1b[39m",
} as const;

const c = (code: string, text: string) => `${code}${text}${STRIP_COLOR.reset}`;

/**
 * Glance-style centered stats strip under the input:
 *   n Turn · n Steps | wall · tool wall | avg TTFT · n tok/s | cache n%
 */
function renderSessionStrip(piContext: unknown): string | null {
  const parts: string[] = [];

  const turns = tpsTracker.getTurnCount();
  const steps = tpsTracker.getStepCount();
  if (turns > 0 || steps > 0) {
    parts.push(`${c(STRIP_COLOR.count, String(turns))} turn \u00b7 ${c(STRIP_COLOR.count, String(steps))} step${steps === 1 ? "" : "s"}`);
  }

  const llmMs = tpsTracker.getSessionLlmMs();
  const toolMs = tpsTracker.getToolMs();
  // Wall + tool time always rendered together once anything is known —
  // '00:00 · tool 00:00' beats a silently missing slot mid-strip.
  if (turns > 0 || steps > 0) {
    parts.push(`${c(STRIP_COLOR.time, fmtWall(llmMs))} \u00b7 tool ${c(STRIP_COLOR.time, fmtWall(toolMs))}`);
  }

  const ttft = tpsTracker.getAvgTtftMs();
  let avgTps = tpsTracker.getSessionAvgTps();
  const tpsColor = avgTps >= 30 ? STRIP_COLOR.psGood : avgTps < 10 ? STRIP_COLOR.psSlow : STRIP_COLOR.psMid;
  const avgTpsLabel = avgTps >= 100
    ? String(Math.round(avgTps))
    : avgTps > 0
      ? avgTps.toFixed(1)
      : "0";
  if (ttft !== null || steps > 0) {
    const seg = [
      ttft !== null ? c(STRIP_COLOR.ttft, ttft >= 10000 ? `${Math.round(ttft / 1000)}s` : `${ttft}ms`) + " avg ttft" : null,
      steps > 0 ? c(tpsColor, `${avgTpsLabel} tok/s`) : null,
    ].filter(Boolean).join(" \u00b7 ");
    if (seg) parts.push(seg);
  }

  const hit = cacheHitPct(piContext);
  if (hit !== null) {
    const hitColor = hit >= 70 ? STRIP_COLOR.cacheHit : STRIP_COLOR.cacheWarn;
    parts.push(c(hitColor, `${hit}% cache hit`));
  }

  if (parts.length === 0) return null;
  return parts.join(" | ");
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
 * time. This complements the 1s branch-scan in the refresh timer, which only
 * sees persisted (completed) messages. Without these hooks the tracker would
 * never observe an in-flight assistant message, so live TPS would stay frozen
 * at the last completed message's value.
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
