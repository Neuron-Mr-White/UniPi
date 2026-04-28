/**
 * @pi-unipi/kanboard — Command Registration
 *
 * Registers kanboard, kanboard-doctor, and name-gen commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { UNIPI_PREFIX, KANBOARD_COMMANDS, KANBOARD_DIRS, UNIPI_EVENTS, emitEvent } from "@pi-unipi/core";
import { startServer, KanboardServer } from "./server/index.js";
import { renderKanboardOverlay } from "./tui/kanboard-overlay.js";
import { KanboardSettingsOverlay } from "./tui/settings-overlay.js";

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

  // kanboard-settings — Configure kanboard module
  pi.registerCommand(
    `${UNIPI_PREFIX}kanboard-settings`,
    {
      description: "Configure kanboard module settings",
      handler: async (_args: string, ctx: any) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Settings require an interactive UI.", "warning");
          return;
        }

        ctx.ui.custom(
          (tui: any, _theme: any, _keybindings: any, done: any) => {
            const overlay = new KanboardSettingsOverlay();
            overlay.onClose = () => done(undefined);
            return {
              render: (w: number) => overlay.render(w),
              invalidate: () => overlay.invalidate(),
              handleInput: (data: string) => {
                overlay.handleInput(data);
                tui.requestRender();
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              width: "80%",
              minWidth: 50,
              anchor: "center",
              margin: 2,
            },
          },
        );
      },
    },
  );

  // name-gen — Generate session name badge
  pi.registerCommand(
    `${UNIPI_PREFIX}${KANBOARD_COMMANDS.NAME_GEN}`,
    {
      description: "Generate session name badge from kanboard context",
      handler: async (_args: string, ctx: any) => {
        if (!ctx.hasUI) {
          ctx.ui.notify("Name generation requires an interactive UI.", "warning");
          return;
        }

        // Emit event so utility module can show badge overlay
        emitEvent(pi, UNIPI_EVENTS.BADGE_GENERATE_REQUEST, {
          source: "kanboard",
        });

        // Send hidden message to LLM to generate session name
        pi.sendMessage(
          {
            customType: "badge-gen",
            content: [
              "[System Instruction: Analyze this conversation and generate a concise session title.",
              "Call the set_session_name tool with a name that is MAXIMUM 5 WORDS.",
              "The name should capture the main topic or task being worked on.",
              "Do not explain your reasoning. Just call set_session_name.]",
            ].join(" "),
            display: false,
          },
          { triggerTurn: true },
        );

        ctx.ui.notify("Generating session name...", "info");
      },
    },
  );
}
