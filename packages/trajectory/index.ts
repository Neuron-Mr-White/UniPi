import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerTelemetryCapture } from "./src/capture.js";
import { projectTrajectory } from "./src/project.js";
import { openBrowser, TrajectoryServer } from "./src/server.js";

let server: TrajectoryServer | null = null;
let currentContext: ExtensionContext | null = null;

function stopServer(): boolean {
  if (!server?.url) return false;
  server.stop();
  server = null;
  return true;
}

export default function trajectory(pi: ExtensionAPI): void {
  const readTelemetry = registerTelemetryCapture(pi);

  pi.registerCommand("unipi:trajectory", {
    description: "Open or manage UniPi's live trajectory for the current session",
    handler: async (args, ctx) => {
      const action = String(args ?? "").trim().toLowerCase();
      const wantsStop = ["stop", "off", "--stop", "--off"].includes(action);
      const wantsToggle = ["toggle", "--toggle"].includes(action);
      if (wantsStop || (wantsToggle && server?.url)) {
        ctx.ui.notify(stopServer() ? "Trajectory stopped" : "Trajectory is not running", "info");
        return;
      }

      currentContext = ctx;
      if (!server) {
        server = new TrajectoryServer({
          snapshot: () => {
            const active = currentContext ?? ctx;
            return projectTrajectory(active.sessionManager.getBranch() as SessionEntry[], {
              sessionId: active.sessionManager.getSessionId(),
              name: active.sessionManager.getSessionName(),
              cwd: active.cwd,
            }, readTelemetry());
          },
        });
      }
      try {
        const url = await server.start();
        openBrowser(url);
        ctx.ui.notify(`Trajectory running at ${url}`, "info");
      } catch (error) {
        ctx.ui.notify(`Trajectory error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => { currentContext = ctx; });
  pi.on("session_shutdown", () => {
    currentContext = null;
    stopServer();
  });
}
