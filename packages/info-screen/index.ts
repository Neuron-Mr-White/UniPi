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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_EVENTS, MODULES, UNIPI_PREFIX, emitEvent, getPackageVersion } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import { registerCoreGroups, trackModule, trackTool, setPiApi, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart } from "./core-groups.js";

/** Re-export for external use */
export { infoRegistry, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart };
import { getInfoSettings } from "./config.js";
import { InfoOverlay } from "./tui/info-overlay.js";
import { SettingsOverlay } from "./settings/settings-tui.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

export default function (pi: ExtensionAPI) {
  setPiApi(pi);

  // Register core groups immediately (synchronous)
  registerCoreGroups();

  // Start load tracking
  startLoadTracking();

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

    // Single cache invalidation for all modules
    infoRegistry.invalidateCache("overview");
    infoRegistry.getGroupData("overview");

    if (hasTools) {
      infoRegistry.invalidateCache("tools");
      infoRegistry.getGroupData("tools");
    }
  }

  // Listen for module announcements — track and trigger reactive updates
  pi.events.on(UNIPI_EVENTS.MODULE_READY, (event: any) => {
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

  pi.events.on(UNIPI_EVENTS.INFO_GROUP_REGISTERED, (_event: any) => {
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
  function showOverlay(ctx: any): void {
    ctx.ui.custom(
      (tui: any, theme: any, _keybindings: any, done: () => void) => {
        const overlay = new InfoOverlay();
        overlay.setTheme(theme);
        overlay.onClose = () => {
          overlay.destroy();
          done();
        };
        overlay.requestRender = () => tui.requestRender();
        return {
          render: (w: number) => overlay.render(w),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "80%",
          minWidth: 60,
          anchor: "center",
          margin: 2,
        },
      }
    );
  }

  // Session lifecycle — show immediately on boot, no blocking wait
  pi.on("session_start", async (event, ctx) => {
    const settings = getInfoSettings();

    if (settings.showOnBoot && event.reason === "startup") {
      // Open immediately — cache-first, no waiting
      showOverlay(ctx);
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
