/**
 * @pi-unipi/ask-user — Extension entry
 *
 * Provides ask_user tool for structured user input with single-select,
 * multi-select, and freeform modes. Includes bundled skill for agent guidance.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  UNIPI_EVENTS,
  MODULES,
  ASK_USER_TOOLS,
  emitEvent,
  getPackageVersion,
} from "@pi-unipi/core";
import { registerAskUserTools } from "./tools.js";
import { registerAskUserCommands } from "./commands.js";

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
  registerAskUserTools(pi);
  registerAskUserCommands(pi);

  // Session lifecycle — announce module
  pi.on("session_start", async () => {
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.ASK_USER,
      version: VERSION,
      commands: ["unipi:ask-user-test"],
      tools: [ASK_USER_TOOLS.ASK],
    });
  });
}
