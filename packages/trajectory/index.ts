import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { registerTelemetryCapture } from "./src/capture.js";
import { projectTrajectory } from "./src/project.js";
import { openBrowser, TrajectoryServer } from "./src/server.js";
import { createUnipiTracer, type UnipiTraceRecorder } from "./src/tracer.js";

export { createUnipiTracer, type UnipiTraceRecorder, type UnipiTracer } from "./src/tracer.js";

let server: TrajectoryServer | null = null;
let currentContext: ExtensionContext | null = null;

function stopServer(): boolean {
  if (!server?.url) return false;
  server.stop();
  server = null;
  return true;
}

export interface TrajectoryOptions {
  traceRecorder?: UnipiTraceRecorder;
}

export default function trajectory(pi: ExtensionAPI, options: TrajectoryOptions = {}): void {
  const recorder = options.traceRecorder ?? createUnipiTracer(pi).recorder;
  const readTelemetry = registerTelemetryCapture(pi, undefined, recorder);

  pi.registerCommand("unipi:trajectory", {
    description: "Open or manage UniPi's live trajectory for the current session",
    getArgumentCompletions: (argumentPrefix: string) => {
      const prefix = argumentPrefix.trim().toLowerCase();
      const actions = [
        { value: "stop", label: "stop", description: "Stop this session's trajectory server" },
        { value: "off", label: "off", description: "Alias of stop" },
        { value: "toggle", label: "toggle", description: "Open when stopped, stop when running" },
      ];
      const matches = prefix
        ? actions.filter((a) => a.value.startsWith(prefix) || a.label.startsWith(prefix))
        : actions;
      // With no prefix (or a matching one) also surface a hint that running bare
      // opens/reuses the server, so users learn the default behavior exists.
      const items = matches.map((a) => ({ value: a.value, label: a.label, description: a.description }));
      if (!prefix) {
        items.unshift({
          value: "",
          label: "(no argument)",
          description: "Open or reuse the trajectory server in the browser",
        });
      }
      return items;
    },
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
