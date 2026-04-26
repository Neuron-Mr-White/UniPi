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
import { UNIPI_EVENTS, MODULES, emitEvent, getPackageVersion } from "@pi-unipi/core";
import { infoRegistry } from "./registry.js";
import { registerCoreGroups, trackModule } from "./core-groups.js";

/** Re-export infoRegistry for external use */
export { infoRegistry };
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
const MODULE_WAIT_TIMEOUT_MS = 2000;

/**
 * Wait for all modules to announce, then return.
 */
async function waitForModules(): Promise<void> {
  const settings = getInfoSettings();
  const timeoutMs = settings.bootTimeoutMs;

  // Wait for module ready or timeout
  await Promise.race([
    moduleReadyPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export default function (pi: ExtensionAPI) {
  // Register core groups on load
  registerCoreGroups();



  // Listen for module announcements
  pi.events.on(UNIPI_EVENTS.MODULE_READY, (event: any) => {
    if (event.name && event.name !== MODULES.INFO_SCREEN) {
      // Track the module
      trackModule(event.name, event.version || "unknown");

      // Signal that a module has announced
      if (!moduleReady) {
        moduleReady = true;
        moduleReadyResolve?.();
      }
    }
  });

  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    const settings = getInfoSettings();

    // Show dashboard on boot if enabled
    if (settings.showOnBoot) {
      // Wait for other modules to announce
      await waitForModules();

      // Show the overlay
      ctx.ui.custom(
        (tui, theme, keybindings, done) => {
          const overlay = new InfoOverlay();

          // Wrap handleInput to detect close keys
          const originalHandleInput = overlay.handleInput.bind(overlay);
          overlay.handleInput = (data: string) => {
            if (data === "q" || data === "\x1b") {
              done(undefined);
              return;
            }
            originalHandleInput(data);
          };

          return overlay;
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

    // Announce module
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.INFO_SCREEN,
      version: VERSION,
      commands: ["unipi:info", "unipi:info-settings"],
      tools: [],
    });
  });

  // Register /unipi:info command
  pi.registerCommand("info", {
    description: "Show info screen dashboard",
    handler: async (_args, ctx) => {
      ctx.ui.custom(
        (tui, theme, keybindings, done) => {
          const overlay = new InfoOverlay();

          // Wrap handleInput to detect close keys
          const originalHandleInput = overlay.handleInput.bind(overlay);
          overlay.handleInput = (data: string) => {
            if (data === "q" || data === "\x1b") {
              done(undefined);
              return;
            }
            originalHandleInput(data);
          };

          return overlay;
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
  pi.registerCommand("info-settings", {
    description: "Configure info screen display",
    handler: async (_args, ctx) => {
      ctx.ui.custom(
        (tui, theme, keybindings, done) => {
          const overlay = new SettingsOverlay();

          // Wrap handleInput to detect close keys
          const originalHandleInput = overlay.handleInput.bind(overlay);
          overlay.handleInput = (data: string) => {
            if (data === "q" || data === "\x1b") {
              done(undefined);
              return;
            }
            originalHandleInput(data);
          };

          return overlay;
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
