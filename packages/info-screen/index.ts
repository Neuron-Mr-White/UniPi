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
import { UNIPI_EVENTS, MODULES, UNIPI_PREFIX, emitEvent, getPackageVersion, type UnipiModuleEvent } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import { registerCoreGroups, trackModule, trackTool, setPiApi, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking } from "./core-groups.js";

/** Re-export for external use */
export { infoRegistry, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking };
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
    // Splash mode (auto-close): the overlay must NEVER take keyboard focus —
    // it lives exactly during the window where the user starts typing their
    // first prompt. A capturing overlay here eats those keystrokes (worse: its
    // vim-style keys "work", so command text vanishes into tab switches), and
    // its first-keypress-cancels-auto-close rule strands it on screen forever
    // as an unclosable, input-eating zombie. Non-capturing + stack-safe
    // self-dismiss (see startBootTimer) makes it pure eye-candy.
    const splashMode = autoCloseMs !== undefined && autoCloseMs > 0;
    ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        overlay = new InfoOverlay();
        overlay.setTheme(theme);
        overlay.interactive = !splashMode;
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
          // In splash mode the overlay is non-capturing and never receives
          // input; keep handleInput wired for interactive ("on") mode.
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
        };
        // Splash self-dismiss may only run while this overlay is the topmost
        // VISIBLE entry of the TUI overlay stack. If the user opens anything
        // during the splash window (a /unipi:… settings dialog, the updater's
        // update prompt, …), dismissal must wait — removing a covered entry
        // breaks the covering overlay (pi retargets focus and orphans its
        // pending interaction, e.g. a hung ctx.ui.select promise). Re-check
        // on every timer tick; once the stack clears we dismiss as usual.
        const isTopmostVisible = (): boolean => {
          try {
            const stack = (tui as unknown as { overlayStack?: Array<{ component?: unknown; hidden?: boolean }> }).overlayStack;
            if (!stack || stack.length === 0) return true;
            for (let i = stack.length - 1; i >= 0; i--) {
              const entry = stack[i];
              if (entry?.hidden) continue;
              return entry?.component === component;
            }
            return true;
          } catch {
            return true; // Stack unreadable — assume topmost (legacy behavior).
          }
        };
        // Boot dashboard dismisses itself (splash mode).
        if (autoCloseMs && autoCloseMs > 0) {
          overlay.startBootTimer(autoCloseMs, isTopmostVisible);
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
          nonCapturing: splashMode,
        },
        // In splash mode the timer uses `selfHide` (handle.hide() splices this
        // entry out by identity) guarded by the topmost-visible check above —
        // never `done()`, which pops whatever is TOPMOST. `isTopmostOverlay`
        // remains as the focused-done() fallback for interactive ("on") mode,
        // where the user drives the dashboard directly: it is topmost while
        // being driven, so the q/Esc → done() path is correct there.
        onHandle: (handle) => {
          overlay.isTopmostOverlay = () => handle.isFocused();
          overlay.selfHide = () => {
            overlayVisible = false;
            if (typeof handle.hide === "function") {
              handle.hide();
            } else if (typeof (handle as { setHidden?: (v: boolean) => void }).setHidden === "function") {
              (handle as { setHidden: (v: boolean) => void }).setHidden(true);
            }
          };
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
