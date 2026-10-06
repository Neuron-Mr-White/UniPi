/**
 * @pi-unipi/ask-user — Extension entry
 *
 * Provides ask_user tool for structured user input with single-select,
 * multi-select, and freeform modes. Includes bundled skill for agent guidance.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  bus,
  UNIPI_EVENTS,
  MODULES,
  ASK_USER_TOOLS,
  getPackageVersion,
} from "@pi-unipi/core";
import { getAskUserSettings } from "./config.js";
import { isSubagentChild, registerAskUserTools, syncAskUserTool } from "./tools.js";

/** Package version */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

export default function (pi: ExtensionAPI) {

  // Register tools
  registerAskUserTools(pi);

  const sync = (cwd?: string) => {
    try {
      const want = getAskUserSettings(cwd).enabled && !isSubagentChild();
      syncAskUserTool(pi, want);
    } catch {
      // tools may not be ready
    }
  };

  // Session lifecycle — announce module
  pi.on("session_start", async (_event, ctx) => {
    sync(ctx?.cwd);
    bus.emit(UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.ASK_USER,
      version: VERSION,
      commands: [],
      tools: [ASK_USER_TOOLS.ASK],
    });
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    sync(ctx?.cwd);
  });
}
