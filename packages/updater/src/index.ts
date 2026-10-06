/**
 * @pi-unipi/updater — Extension entry point
 *
 * Auto-updater, changelog browser, and readme browser for Unipi.
 *
 * On session start: loads config, checks npm registry for updates,
 * shows update overlay if available. Registers commands for
 * /unipi:readme and /unipi:changelog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bus,
  UNIPI_EVENTS,
  MODULES,
  UPDATER_COMMANDS,
  UNIPI_PREFIX,
  getPackageVersion,
} from "@pi-unipi/core";
import { registerCommands } from "./commands.js";
import { loadConfig } from "./settings.js";
import { checkForUpdates } from "./checker.js";
import { isVersionSkipped } from "./cache.js";
import { renderUpdateOverlay } from "./tui/update-overlay.js";
import { loadUpdateChangelog } from "./remote-changelog.js";

/** Package version */
const VERSION = getPackageVersion(new URL("..", import.meta.url).pathname);

export default function updaterExtension(pi: ExtensionAPI): void {

  // Register commands
  registerCommands(pi);

  // Session lifecycle — check for updates and announce module
  pi.on("session_start", async (_event, ctx) => {
    // Emit MODULE_READY
    bus.emit(UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.UPDATER,
      version: VERSION,
      commands: [
        `${UNIPI_PREFIX}${UPDATER_COMMANDS.README}`,
        `${UNIPI_PREFIX}${UPDATER_COMMANDS.CHANGELOG}`,
      ],
      tools: [],
    });

    // Register info-screen group
    const infoRegistry = globalThis.__unipi_info_registry;
    if (infoRegistry) {
      let cachedResult: { currentVersion: string; latestVersion: string; updateAvailable: boolean; lastCheck: string; checkedAt: number } | null = null;

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
          const cfg = loadConfig();
          if (!cachedResult) {
            return {
              current: { value: VERSION },
              latest: { value: "checking…" },
              status: { value: "checking" },
              lastCheck: { value: "never" },
              raw: { value: "", raw: { current: VERSION, latest: null, available: false, checkedAt: 0, mode: cfg.autoUpdate } },
            };
          }
          return {
            current: { value: cachedResult.currentVersion },
            latest: { value: cachedResult.latestVersion },
            status: { value: cachedResult.updateAvailable ? "update available" : "up to date" },
            lastCheck: { value: cachedResult.lastCheck || "never" },
            raw: {
              value: "",
              raw: {
                current: cachedResult.currentVersion,
                latest: cachedResult.latestVersion,
                available: cachedResult.updateAvailable,
                checkedAt: cachedResult.checkedAt,
                mode: cfg.autoUpdate,
              },
            },
          };
        },
      });

      // Subscribe to events to update cached data
      bus.on(pi, UNIPI_EVENTS.UPDATE_CHECK, (payload) => {
        cachedResult = {
          currentVersion: payload.currentVersion,
          latestVersion: payload.latestVersion,
          updateAvailable: payload.updateAvailable,
          lastCheck: new Date().toLocaleTimeString(),
          checkedAt: Date.now(),
        };
      });

      bus.on(pi, UNIPI_EVENTS.UPDATE_AVAILABLE, () => {
        if (cachedResult) {
          cachedResult.updateAvailable = true;
        }
      });

      bus.on(pi, UNIPI_EVENTS.UPDATE_APPLIED, () => {
        if (cachedResult) {
          cachedResult.updateAvailable = false;
        }
      });
    }

    // Check for updates in background
    const config = loadConfig();
    if (config.autoUpdate === "disabled") return;

    try {
      const result = await checkForUpdates();

      // Emit check event
      bus.emit(UNIPI_EVENTS.UPDATE_CHECK, result);

      if (!result.updateAvailable || result.error) return;

      // Check if user skipped this version
      if (isVersionSkipped(result.latestVersion)) return;

      // Emit available event
      bus.emit(UNIPI_EVENTS.UPDATE_AVAILABLE, {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
      });

      // Show update overlay if UI is available
      if (ctx.hasUI) {
        const entries = await loadUpdateChangelog(result.currentVersion, result.latestVersion);
        const updateResult = await ctx.ui.custom(
          renderUpdateOverlay(result, entries),
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
}
