/**
 * @pi-unipi/utility — Extension entry
 *
 * Provides /unipi:continue command and continue_task tool for clean
 * agent continuation without context pollution.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  UTILITY_COMMANDS,
  UTILITY_TOOLS,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import { registerUtilityCommands } from "./commands.js";
import { registerUtilityTools } from "./tools.js";

/** Package version */
const VERSION = getPackageVersion(new URL(".", import.meta.url).pathname);

export default function (pi: ExtensionAPI) {
  // Register commands and tools
  registerUtilityCommands(pi);
  registerUtilityTools(pi);

  // Session lifecycle — announce module
  pi.on("session_start", async () => {
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.UTILITY,
      version: VERSION,
      commands: [`unipi:${UTILITY_COMMANDS.CONTINUE}`],
      tools: [UTILITY_TOOLS.CONTINUE],
    });
  });
}
