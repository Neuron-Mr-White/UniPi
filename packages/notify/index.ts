/**
 * @pi-unipi/notify — Extension entry
 *
 * Cross-platform notification system for Pi.
 * Bridges agent lifecycle events to external platforms (native OS, Gotify, Telegram).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  NOTIFY_TOOLS,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import { registerNotifyTools } from "./tools.js";
import { registerNotifyCommands } from "./commands.js";
import { loadConfig } from "./settings.js";
import {
  registerEventListeners,
  unregisterEventListeners,
  setSessionContext,
  clearSessionContext,
} from "./events.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

export default function (pi: ExtensionAPI) {
  // Register skills directory
  const skillsDir = new URL("./skills", import.meta.url).pathname;
  pi.on("resources_discover", async () => {
    return {
      skillPaths: [skillsDir],
    };
  });

  // Register tools and commands
  registerNotifyTools(pi);
  registerNotifyCommands(pi);

  // Session lifecycle — register events and announce module
  pi.on("session_start", async (_event, ctx) => {
    setSessionContext(ctx);
    const config = loadConfig();
    registerEventListeners(pi, config);

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.NOTIFY,
      version: VERSION,
      commands: ["unipi:notify-settings", "unipi:notify-set-gotify", "unipi:notify-set-tg", "unipi:notify-set-ntfy", "unipi:notify-test", "unipi:notify-recap-model"],
      tools: [NOTIFY_TOOLS.NOTIFY_USER],
    });
  });

  // Cleanup on session shutdown
  pi.on("session_shutdown", async () => {
    clearSessionContext();
    unregisterEventListeners();
  });
}
