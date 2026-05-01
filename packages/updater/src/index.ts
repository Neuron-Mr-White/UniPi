/**
 * @pi-unipi/updater — Extension entry point
 *
 * Auto-updater, changelog browser, and readme browser for Unipi.
 *
 * On session start: loads config, checks npm registry for updates,
 * shows update overlay if available. Registers commands for
 * /unipi:readme, /unipi:changelog, /unipi:updater-settings.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  UPDATER_COMMANDS,
  UNIPI_PREFIX,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import { registerCommands } from "./commands.js";
import { loadConfig } from "./settings.js";
import { checkForUpdates } from "./checker.js";
import { isVersionSkipped } from "./cache.js";
import { renderUpdateOverlay } from "./tui/update-overlay.js";

/** Package version */
const VERSION = getPackageVersion(new URL("..", import.meta.url).pathname);

export default function updaterExtension(pi: ExtensionAPI): void {
  // Register skills directory
  const skillsDir = new URL("../skills", import.meta.url).pathname;
  pi.on("resources_discover", async () => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Register commands
  registerCommands(pi);

  // Session lifecycle — check for updates and announce module
  pi.on("session_start", async (_event, ctx) => {
    // Emit MODULE_READY
    emitEvent(pi as any, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.UPDATER,
      version: VERSION,
      commands: [
        `${UNIPI_PREFIX}${UPDATER_COMMANDS.README}`,
        `${UNIPI_PREFIX}${UPDATER_COMMANDS.CHANGELOG}`,
        `${UNIPI_PREFIX}${UPDATER_COMMANDS.UPDATER_SETTINGS}`,
      ],
      tools: [],
    });

    // Register info-screen group
    const infoRegistry = (globalThis as any).__unipi_info_registry;
    if (infoRegistry) {
      let cachedResult: { currentVersion: string; latestVersion: string; updateAvailable: boolean; lastCheck: string } | null = null;

      infoRegistry.registerGroup({
        id: "updater",
        name: "Updater",
        icon: "📦",
        priority: 20,
        config: {
          showByDefault: true,
          stats: [
            { id: "current", label: "Installed", show: true },
            { id: "latest", label: "Latest", show: true },
            { id: "status", label: "Status", show: true },
            { id: "lastCheck", label: "Last check", show: true },
          ],
        },
        dataProvider: async () => {
          if (!cachedResult) {
            return {
              current: VERSION,
              latest: "checking...",
              status: "⏳ Checking",
              lastCheck: "never",
            };
          }
          return {
            current: cachedResult.currentVersion,
            latest: cachedResult.latestVersion,
            status: cachedResult.updateAvailable ? "↑ Update available" : "✓ Up to date",
            lastCheck: cachedResult.lastCheck || "never",
          };
        },
      });

      // Subscribe to events to update cached data
      pi.events.on(UNIPI_EVENTS.UPDATE_CHECK, (payload: any) => {
        cachedResult = {
          currentVersion: payload.currentVersion,
          latestVersion: payload.latestVersion,
          updateAvailable: payload.updateAvailable,
          lastCheck: new Date().toLocaleTimeString(),
        };
        emitEvent(pi as any, UNIPI_EVENTS.INFO_DATA_UPDATED, {
          groupId: "updater",
          keys: ["current", "latest", "status", "lastCheck"],
        });
      });

      pi.events.on(UNIPI_EVENTS.UPDATE_AVAILABLE, (_payload: any) => {
        if (cachedResult) {
          cachedResult.updateAvailable = true;
        }
        emitEvent(pi as any, UNIPI_EVENTS.INFO_DATA_UPDATED, {
          groupId: "updater",
          keys: ["status"],
        });
      });

      pi.events.on(UNIPI_EVENTS.UPDATE_APPLIED, (_payload: any) => {
        if (cachedResult) {
          cachedResult.updateAvailable = false;
        }
        emitEvent(pi as any, UNIPI_EVENTS.INFO_DATA_UPDATED, {
          groupId: "updater",
          keys: ["status"],
        });
      });
    }

    // Check for updates in background
    const config = loadConfig();
    if (config.autoUpdate === "disabled") return;

    try {
      const result = await checkForUpdates();

      // Emit check event
      emitEvent(pi as any, UNIPI_EVENTS.UPDATE_CHECK, result);

      if (!result.updateAvailable || result.error) return;

      // Check if user skipped this version
      if (isVersionSkipped(result.latestVersion)) return;

      // Emit available event
      emitEvent(pi as any, UNIPI_EVENTS.UPDATE_AVAILABLE, {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
      });

      // Show update overlay if UI is available
      if (ctx.hasUI) {
        const updateResult = await ctx.ui.custom(
          renderUpdateOverlay(result),
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 60,
              anchor: "center",
              margin: 2,
            },
          },
        );
        if (updateResult?.updated) {
          ctx.ui.notify(
            `Updated to ${result.latestVersion}. Restart pi to apply.`,
            "info",
          );
        }
      }
    } catch (_err) {
      // Update check failure — silent, non-critical
    }
  });

  // Cleanup on session shutdown
  pi.on("session_shutdown", async () => {
    // No cleanup needed
  });
}
