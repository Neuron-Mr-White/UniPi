/**
 * @pi-unipi/kanboard — Command Registration
 *
 * Registers kanboard and kanboard-doctor commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, KANBOARD_COMMANDS, KANBOARD_DIRS, UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import { startServer, KanboardServer } from "./server/index.js";
import { renderKanboardOverlay } from "./tui/kanboard-overlay.js";

/** Module-level reference to running server */
let runningServer: KanboardServer | null = null;

/** Check if a kanboard server is running via PID file */
function isPidFileRunning(pidFile: string): boolean {
  try {
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Process doesn't exist or can't access PID file
    try {
       fs.unlinkSync(pidFile);
    } catch {}
    return false;
  }
}

/** Register kanboard commands */
export function registerCommands(pi: ExtensionAPI): void {
  // kanboard — Toggle server start/stop
  pi.registerCommand(
    `${UNIPI_PREFIX}${KANBOARD_COMMANDS.KANBOARD}`,
    {
      description: "Toggle kanboard visualization server",
      handler: async (_args: string, ctx: any) => {
        const pidFile = path.resolve(KANBOARD_DIRS.PID_FILE);

        try {
          // Case 1: We have a live reference in this process
          if (runningServer) {
            runningServer.stop();
            runningServer = null;
            ctx.ui.notify("Kanboard stopped", "info");
            return;
          }

          // Case 2: PID file shows a running instance (from previous process)
          if (isPidFileRunning(pidFile)) {
            // PID file exists but we don't have a reference — stale or external.
            // Remove stale PID file and let user know.
            try { fs.unlinkSync(pidFile); } catch {}
            ctx.ui.notify("Kanboard was running in a previous session. PID file cleaned. Run again to start fresh.", "info");
            return;
          }

          // Case 3: No running instance — start fresh
          const { server, url } = await startServer();
          runningServer = server;
          ctx.ui.notify(`Kanboard running at ${url}`, "info");
        } catch (err: any) {
          ctx.ui.notify(`Kanboard error: ${err.message}`, "error");
        }
      },
    },
  );

  // kanboard-doctor — Load doctor skill
  pi.registerCommand(
    `${UNIPI_PREFIX}${KANBOARD_COMMANDS.KANBOARD_DOCTOR}`,
    {
      description: "Diagnose and fix kanboard parser issues",
      handler: async (_args: string, ctx: any) => {
        ctx.ui.notify("Loading kanboard-doctor skill...", "info");
        // The skill will be loaded by the skill system via resources_discover
      },
    },
  );
}
