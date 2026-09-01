/**
 * @pi-unipi/notify — Extension entry
 *
 * Cross-platform notification system for Pi.
 * Bridges agent lifecycle events to external platforms (native OS, Gotify, Telegram).
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { noteInput, resetInputActivity } from "./activity.js";

/** Package version */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Unsubscribe for the interactive-mode keypress listener. */
let unsubTerminalInput: (() => void) | undefined;

export default function (pi: ExtensionAPI) {

  // Register tools and commands
  registerNotifyTools(pi);
  registerNotifyCommands(pi);

  // Session lifecycle — register events and announce module
  pi.on("session_start", async (_event, ctx) => {
    setSessionContext(ctx);
    resetInputActivity();
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    const onTerminalInput = ctx.ui?.onTerminalInput;
    if (typeof onTerminalInput === "function") {
      try {
        unsubTerminalInput = onTerminalInput(() => {
          noteInput();
        });
      } catch {
        unsubTerminalInput = undefined;
      }
    }
    const cwd = process.cwd();
    const config = loadConfig();
    registerEventListeners(pi, config, cwd);

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.NOTIFY,
      version: VERSION,
      commands: ["unipi:notify-settings", "unipi:notify-set-gotify", "unipi:notify-set-tg", "unipi:notify-set-ntfy", "unipi:notify-test", "unipi:notify-recap-model"],
      tools: [NOTIFY_TOOLS.NOTIFY_USER],
    });
  });

  // Cleanup on session shutdown
  pi.on("session_shutdown", async () => {
    unsubTerminalInput?.();
    unsubTerminalInput = undefined;
    resetInputActivity();
    clearSessionContext();
    unregisterEventListeners();
  });
}
