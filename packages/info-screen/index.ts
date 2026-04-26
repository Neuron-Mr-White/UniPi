/**
 * @pi-unipi/info-screen — Extension entry
 *
 * Dashboard and module registry for Unipi.
 * Shows configurable info overlay on boot and via /unipi:info command.
 *
 * Usage:
 *   /unipi:info          - Show info dashboard
 *   /unipi:info-settings - Configure info display
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { UNIPI_EVENTS, MODULES, UNIPI_PREFIX, emitEvent, getPackageVersion } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import { registerCoreGroups, trackModule, trackTool, setPiApi, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart } from "./core-groups.js";

/** Re-export infoRegistry, registerSkillDir, and load tracking for external use */
export { infoRegistry, registerSkillDir, startLoadTracking, recordLoadTime, finishLoadTracking, recordModuleStart };
import { getInfoSettings } from "./config.js";
import { InfoOverlay } from "./tui/info-overlay.js";
import { SettingsOverlay } from "./settings/settings-tui.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

/** Module ready tracking */
let moduleReady = false;
let moduleReadyResolve: (() => void) | null = null;
const moduleReadyPromise = new Promise<void>((resolve) => {
  moduleReadyResolve = resolve;
});

/** Timeout for waiting for modules */
const MODULE_WAIT_TIMEOUT_MS = 5000;

/**
 * Wait for modules to announce, then return.
 */
async function waitForModules(): Promise<void> {
  const settings = getInfoSettings();
  const timeoutMs = settings.bootTimeoutMs || MODULE_WAIT_TIMEOUT_MS;

  // Wait a bit for modules to announce
  // We wait for the full timeout to give all modules time to emit MODULE_READY
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}

export default function (pi: ExtensionAPI) {
  // Set pi API reference for tools access
  setPiApi(pi);

  // Register core groups on load
  registerCoreGroups();



  // Start load tracking
  startLoadTracking();

  // Listen for module announcements
  pi.events.on(UNIPI_EVENTS.MODULE_READY, (event: any) => {
    if (event.name && event.name !== MODULES.INFO_SCREEN) {
      // Track the module
      trackModule(event.name, event.version || "unknown");
      recordLoadTime(event.name, "module", event.loadTimeMs);

      // Track tools from this module
      if (event.tools && Array.isArray(event.tools)) {
        for (const tool of event.tools) {
          trackTool(tool, event.name);
        }
      }

      // Signal that a module has announced
      if (!moduleReady) {
        moduleReady = true;
        moduleReadyResolve?.();
      }
    }
  });

  // Listen for info group registrations via events
  pi.events.on(UNIPI_EVENTS.INFO_GROUP_REGISTERED, (_event: any) => {
    // Group already registered via globalThis in registerGroup()
  });

  // Also track built-in tools by intercepting tool calls
  const trackedBuiltinTools = new Set<string>();
  pi.on("tool_call", async (event, _ctx) => {
    const toolName = event.toolName;
    if (!trackedBuiltinTools.has(toolName)) {
      trackedBuiltinTools.add(toolName);
      trackTool(toolName, "builtin");
    }
    return undefined; // Don't block the tool call
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    const settings = getInfoSettings();

    // Show dashboard on boot if enabled
    if (settings.showOnBoot) {
      // Wait for other modules to announce
      await waitForModules();

      // Show the overlay using three-method object pattern
      ctx.ui.custom(
        (tui, _theme, _keybindings, done) => {
          const overlay = new InfoOverlay();
          overlay.onClose = () => done(undefined);
          // Return three-method object as per pi-tui docs
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
            width: "80%",
            minWidth: 60,
            anchor: "center",
            margin: 2,
          },
        }
      );
    }

    // Finish load tracking
    finishLoadTracking();

    // Announce module
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.INFO_SCREEN,
      version: VERSION,
      commands: ["unipi:info", "unipi:info-settings"],
      tools: [],
    });
  });

  // Register /unipi:info command
  pi.registerCommand(`${UNIPI_PREFIX}info`, {
    description: "Show info screen dashboard",
    handler: async (_args, ctx) => {
      ctx.ui.custom(
        (tui, _theme, _keybindings, done) => {
          const overlay = new InfoOverlay();
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
            width: "80%",
            minWidth: 60,
            anchor: "center",
            margin: 2,
          },
        }
      );
    },
  });

  // Register /unipi:info-settings command
  pi.registerCommand(`${UNIPI_PREFIX}info-settings`, {
    description: "Configure info screen display",
    handler: async (_args, ctx) => {
      ctx.ui.custom(
        (tui, _theme, _keybindings, done) => {
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
