/**
 * @pi-unipi/info-screen — Extension entry
 *
 * Cache-first reactive dashboard.
 * Opens immediately with cached data, updates in background.
 *
 * Usage:
 *   /unipi:info          - Show info dashboard
 *   /unipi:info-settings - Configure info display
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UNIPI_EVENTS, MODULES, UNIPI_PREFIX, emitEvent, getPackageVersion, type UnipiModuleEvent, type UnipiInfoGroupEvent } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import { registerCoreGroups, trackModule, trackTool, setPiApi, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart } from "./core-groups.js";

/** Re-export for external use */
export { infoRegistry, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart };
import { getInfoSettings } from "./config.js";
import { InfoOverlay } from "./tui/info-overlay.js";
import { SettingsOverlay } from "./settings/settings-tui.js";

/** Package version */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

export default function (pi: ExtensionAPI) {
  setPiApi(pi);

  // Register core groups immediately (synchronous)
  registerCoreGroups();

  // Start load tracking
  startLoadTracking();

  // Whether an info overlay is currently on screen. Module announcements only
  // trigger a re-fetch when something is actually displaying the result.
  let overlayVisible = false;

  // Debounced MODULE_READY handling — batch module announcements
  // to prevent layout shift from rapid per-module cache invalidation.
  let moduleReadyBatch: Array<{ name: string; version: string; tools?: string[]; loadTimeMs?: number }> = [];
  let moduleReadyTimer: ReturnType<typeof setTimeout> | null = null;
  const MODULE_READY_DEBOUNCE_MS = 150;

  function flushModuleReadyBatch(): void {
    const batch = moduleReadyBatch;
    moduleReadyBatch = [];
    moduleReadyTimer = null;

    if (batch.length === 0) return;

    // Track all modules and tools
    let hasTools = false;
    for (const event of batch) {
      trackModule(event.name, event.version || "unknown");
      recordLoadTime(event.name, "module", event.loadTimeMs);
      if (event.tools && Array.isArray(event.tools)) {
        for (const tool of event.tools) {
          trackTool(tool, event.name);
        }
        hasTools = true;
      }
    }

    // Single cache invalidation for all modules.
    //
    // Only re-fetch while an overlay is actually on screen. Otherwise this
    // ran every module announcement even with the dashboard disabled,
    // doing work nobody would see.
    infoRegistry.invalidateCache("overview");
    if (hasTools) infoRegistry.invalidateCache("tools");

    if (!overlayVisible) return;

    infoRegistry.getGroupData("overview");
    if (hasTools) infoRegistry.getGroupData("tools");
  }

  // Listen for module announcements — track and trigger reactive updates
  pi.events.on(UNIPI_EVENTS.MODULE_READY, (data) => {
    const event = data as UnipiModuleEvent;
    if (event.name && event.name !== MODULES.INFO_SCREEN) {
      moduleReadyBatch.push({
        name: event.name,
        version: event.version,
        tools: event.tools,
        loadTimeMs: event.loadTimeMs,
      });

      // Debounce: wait for more modules to arrive, then flush once
      if (moduleReadyTimer) clearTimeout(moduleReadyTimer);
      moduleReadyTimer = setTimeout(flushModuleReadyBatch, MODULE_READY_DEBOUNCE_MS);
    }
  });

  pi.events.on(UNIPI_EVENTS.INFO_GROUP_REGISTERED, (_data) => {
    // Group already registered via globalThis in registerGroup()
  });

  // Track built-in tools
  const trackedBuiltinTools = new Set<string>();
  pi.on("tool_call", async (event, _ctx) => {
    const toolName = event.toolName;
    if (!trackedBuiltinTools.has(toolName)) {
      trackedBuiltinTools.add(toolName);
      trackTool(toolName, "builtin");
    }
    return undefined;
  });

  /**
   * Show the info overlay immediately.
   * Cache-first: opens with whatever data is cached (even empty).
   * Background: each group fetches independently, overlay re-renders reactively.
   */
  function showOverlay(ctx: ExtensionContext, autoCloseMs?: number): void {
    let overlay: InfoOverlay;
    ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        overlay = new InfoOverlay();
        overlay.setTheme(theme);
        overlayVisible = true;
        overlay.onClose = () => {
          overlayVisible = false;
          overlay.destroy();
          done();
        };
        overlay.requestRender = () => tui.requestRender();
        const component = {
          render: (w: number) => overlay.render(w),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
        };
        // Boot dashboard dismisses itself; any keypress cancels the timer.
        if (autoCloseMs && autoCloseMs > 0) {
          overlay.startBootTimer(autoCloseMs);
        }
        return component;
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%" as const,
          minWidth: 60,
          anchor: "center" as const,
          margin: 2,
        },
        // `done()` (the extension UI's close callback) pops the *topmost* overlay
        // in the TUI stack, not this one specifically. When another overlay (e.g.
        // the updater's "Update Available" prompt) is stacked on top, the boot
        // auto-close timer must not fire `done()` — that would pop the covering
        // overlay and strand this dashboard with a spent one-shot close the user
        // can no longer dismiss. `isTopmostOverlay` lets the boot timer defer
        // until we are the focused (topmost) entry; the user can still press
        // q/Esc to close once the covering overlay is gone.
        onHandle: (handle) => {
          overlay.isTopmostOverlay = () => handle.isFocused();
        },
      }
    );
  }

  // Session lifecycle — show immediately on boot, no blocking wait
  pi.on("session_start", async (event, ctx) => {
    const settings = getInfoSettings();

    if (settings.bootMode !== "off" && event.reason === "startup") {
      // Open immediately — cache-first, no waiting. In "auto-close" mode the
      // overlay dismisses itself after bootTimeoutMs; any keypress cancels it.
      showOverlay(ctx, settings.bootMode === "auto-close" ? settings.bootTimeoutMs : 0);
    }

    finishLoadTracking();

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.INFO_SCREEN,
      version: VERSION,
      commands: ["unipi:info", "unipi:info-settings"],
      tools: [],
    });
  });

  // /unipi:info — open immediately
  pi.registerCommand(`${UNIPI_PREFIX}info`, {
    description: "Show info screen dashboard",
    handler: async (_args, ctx) => {
      showOverlay(ctx);
    },
  });

  // /unipi:info-settings
  pi.registerCommand(`${UNIPI_PREFIX}info-settings`, {
    description: "Configure info screen display",
    handler: async (_args, ctx) => {
      ctx.ui.custom(
        (tui: any, _theme: any, _keybindings: any, done: any) => {
          const overlay = new SettingsOverlay();
          overlay.onClose = () => done(undefined);
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput?.(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            width: "60%",
            minWidth: 50,
            anchor: "center",
            margin: 2,
          },
        }
      );
    },
  });
}
