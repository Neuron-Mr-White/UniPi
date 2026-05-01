/**
 * @pi-unipi/footer — Extension entry point
 *
 * Main extension function that registers commands, subscribes to events,
 * initializes renderer on session_start.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { UNIPI_EVENTS, emitEvent, UNIPI_PREFIX, FOOTER_COMMANDS } from "@pi-unipi/core";
import { FooterRegistry, getFooterRegistry } from "./registry/index.js";
import { FooterRenderer } from "./rendering/renderer.js";
import { subscribeToEvents } from "./events.js";
import { loadFooterSettings, saveFooterSettings } from "./config.js";
import { getPreset } from "./presets.js";
import { registerCommands } from "./commands.js";

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
import { rainbowBorder } from "./segments/core.js";
import { tpsTracker } from "./tps-tracker.js";

/** All segment groups */
const ALL_GROUPS: FooterGroup[] = [
  { id: "core", name: "Core", icon: "", segments: CORE_SEGMENTS, defaultShow: true },
  { id: "compactor", name: "Compactor", icon: "", segments: COMPACTOR_SEGMENTS, defaultShow: true },
  { id: "memory", name: "Memory", icon: "", segments: MEMORY_SEGMENTS, defaultShow: true },
  { id: "mcp", name: "MCP", icon: "", segments: MCP_SEGMENTS, defaultShow: true },
  { id: "ralph", name: "Ralph", icon: "", segments: RALPH_SEGMENTS, defaultShow: true },
  { id: "workflow", name: "Workflow", icon: "", segments: WORKFLOW_SEGMENTS, defaultShow: true },
  { id: "kanboard", name: "Kanboard", icon: "", segments: KANBOARD_SEGMENTS, defaultShow: true },
  { id: "notify", name: "Notify", icon: "", segments: NOTIFY_SEGMENTS, defaultShow: false },
  { id: "status_ext", name: "Extensions", icon: "", segments: STATUS_EXT_SEGMENTS, defaultShow: true },
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
  tuiRef: any;
  refreshTimer: ReturnType<typeof setInterval> | null;
  /** Re-register footer + widgets with pi UI (for live enable) */
  setupUI: ((pi: ExtensionAPI, ctx: any) => void) | null;
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
      { get: (id: string) => segmentLookup.get(id) },
      loadFooterSettings().preset,
    ),
    segmentLookup,
    unsubscribeEvents: null,
    piContext: null,
    footerData: null,
    tuiRef: null,
    refreshTimer: null,
    setupUI: null,
  };

  // Register all groups in the registry
  for (const group of ALL_GROUPS) {
    state.registry.registerGroup(group);
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const settings = loadFooterSettings();
    state.enabled = settings.enabled;
    state.piContext = ctx;
    state.renderer.setPreset(settings.preset);
    state.renderer.setActive(settings.enabled);

    if (!settings.enabled || !ctx.hasUI) return;

    // Subscribe to events
    state.unsubscribeEvents = subscribeToEvents(pi, state.registry);

    // Setup footer + widgets
    setupFooterUI(pi, ctx, state);
    state.setupUI = (p: ExtensionAPI, c: any) => setupFooterUI(p, c, state);
  });

  pi.on("session_shutdown", async () => {
    state.renderer.setActive(false);
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
  });

  // ─── Register commands ──────────────────────────────────────────────────

  registerCommands(pi, state, ALL_GROUPS);

  // ─── Emit MODULE_READY ──────────────────────────────────────────────────

  pi.on("session_start", async () => {
    emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
      name: "@pi-unipi/footer",
      version: "0.1.0",
      commands: [`${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER}`, `${UNIPI_PREFIX}${FOOTER_COMMANDS.FOOTER_SETTINGS}`],
      tools: [],
    });
  });
}

// ─── Footer UI setup ────────────────────────────────────────────────────────

function setupFooterUI(pi: ExtensionAPI, ctx: any, state: FooterState): void {
  // Register footer (minimal — handles branch changes)
  ctx.ui.setFooter((tui: any, _theme: Theme, footerData: any) => {
    state.tuiRef = tui;

    // Start periodic refresh for time-sensitive segments (e.g. clock)
    if (!state.refreshTimer) {
      state.refreshTimer = setInterval(() => {
        // Feed TPS tracker with current output token count
        try {
          const piCtx = state.piContext as Record<string, unknown> | undefined;
          if (piCtx?.sessionManager) {
            const sm = (piCtx as any).sessionManager;
            const events = sm?.getBranch?.() ?? [];
            let totalOutput = 0;
            for (const e of events) {
              if (!e || typeof e !== "object") continue;
              if (e.type !== "message") continue;
              const m = e.message;
              if (!m || m.role !== "assistant") continue;
              if (m.stopReason === "error" || m.stopReason === "aborted") continue;
              totalOutput += m.usage?.output ?? 0;
            }
            tpsTracker.onTokenEvent(Date.now(), totalOutput);
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

  // Top row widget
  ctx.ui.setWidget("footer-top", (_tui: any, theme: Theme) => {
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
        if (!state.enabled || !state.piContext) return [];

        // Build layout with proper theme by creating segment contexts
        const layout = state.renderer.computeLayout(width);
        return layout.topContent ? [layout.topContent] : [];
      },
    };
  }, { placement: "aboveEditor" });

  // Secondary row widget
  ctx.ui.setWidget("footer-secondary", (_tui: any, _theme: Theme) => {
    return {
      dispose() {},
      invalidate() {
        state.renderer.resetLayoutCache();
      },
      render(width: number): string[] {
        if (!state.enabled || !state.piContext) return [];

        const lines: string[] = [];

        const layout = state.renderer.computeLayout(width);
        if (layout.secondaryContent) {
          lines.push(layout.secondaryContent);
        }

        return lines;
      },
    };
  }, { placement: "belowEditor" });
}
