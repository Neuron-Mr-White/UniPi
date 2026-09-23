/**
 * @pi-unipi/workflow — Plan mode + permission modes
 *
 * Formerly the workflow command suite (brainstorm/plan/work/…); those twenty
 * slash commands and their skill-dispatch sandboxes were removed in favor of
 * two orthogonal, always-on mechanisms (permission modes and plan mode), which
 * land in the following commits. The bundled skills moved to
 * @pi-unipi/skill-registry.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MODULES,
  UNIPI_EVENTS,
  emitEvent,
  getPackageVersion,
  initUnipiDirs,
} from "@pi-unipi/core";

/** Package version (read from package.json at load time) */
const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

export default function (pi: ExtensionAPI) {
  // Announce module presence on session start.
  pi.on("session_start", async (_event, ctx) => {
    initUnipiDirs();

    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.WORKFLOW,
      version: VERSION,
      commands: [],
      tools: [],
    });

    ctx.ui.setStatus("unipi-workflow", undefined);
  });
}
