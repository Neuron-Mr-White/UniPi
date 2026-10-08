/**
 * @pi-unipi/background-tasks — Module entry
 *
 * Master-toggle gate: when config `enabled` is false, this registers NOTHING
 * (no tools, no commands, no hooks, no UI).
 *
 * Ported from pi-background-tasks src/extension.ts. Conventions ours:
 * /unipi:* commands, temp-root runtime dir, UNIPI_BG_* env, update-check
 * dropped (our updater module owns updates).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createSpinnerLine,
  isChildProcess,
  registerWaitSource,
  setBashBackgroundAdopter,
  type BashBackgroundRequest,
  type BashDetachResult,
} from "@pi-unipi/core";
import { loadBackgroundTasksConfig } from "./config.js";
import { BackgroundTaskRegistry } from "./registry.js";
import {
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionService,
} from "./extension-api.js";
import { registerToolsAndCommands } from "./tools.js";
import { setSharedTaskRegistry, clearSharedTaskRegistry, notifyTaskRegistryChange } from "./registry-shared.js";
import { formatDuration, taskDisplayName, type BgTask, type StartTaskOptions } from "./types.js";

const STATUS_INTERVAL_MS = 1000;

// Direct synchronous access for sibling extensions (footer process one-liner).
export { getSharedTaskRegistry } from "./registry-shared.js";

/** Live line above the editor: the agent is idle but a task will wake it. */
function pendingWakeText(registry: BackgroundTaskRegistry, isIdle: () => boolean): string | undefined {
  if (!isIdle()) return undefined;
  const pendingWake = registry
    .allTasks()
    .filter((task) => task.status === "running" && task.triggerOnCompletion);
  if (pendingWake.length === 0) return undefined;
  const now = Date.now();
  const first = pendingWake[0];
  const detail =
    first === undefined
      ? ""
      : ` · ${taskDisplayName(first)} ${formatDuration(now - first.startTime)}${pendingWake.length > 1 ? ` +${String(pendingWake.length - 1)} more` : ""}`;
  const count = pendingWake.length === 1 ? "1 bg task" : `${String(pendingWake.length)} bg tasks`;
  return `waiting on ${count}${detail} — agent resumes automatically when done`;
}

/** Arbiter wait-source reason (lead only): what a running wake-task is, or null. */
export function pendingWakeReason(tasks: readonly { status: string; triggerOnCompletion: boolean; command?: string; name?: string; description?: string; id?: string }[]): string | null {
  const pendingWake = tasks.filter((task) => task.status === "running" && task.triggerOnCompletion);
  if (pendingWake.length === 0) return null;
  const first = pendingWake[0];
  const more = pendingWake.length > 1 ? ` +${String(pendingWake.length - 1)} more` : "";
  return `bg: ${first === undefined ? "task" : taskDisplayName(first)}${more}`;
}

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  const { config, warnings } = loadBackgroundTasksConfig(process.cwd());

  for (const warning of warnings) {
    console.error(`[background-tasks] ${warning}`);
  }

  if (!config.enabled) {
    return;
  }

  const seenTaskIds = new Set<string>();
  let currentCtx: ExtensionContext | undefined;
  let dockOpen = false;
  let wakeLineInstalled = false;
  let statusInterval: NodeJS.Timeout | undefined;

  const registry = new BackgroundTaskRegistry({
    maxOutputBytes: config.maxOutputBytes,
    maxRecentTasks: config.maxFinishedTasks,
    onChange: () => {
      updateUi();
      notifyTaskRegistryChange();
    },
    sendCompletionNotification: (message, options) => {
      // Our sendMessage path (same contract as reference; pi delivers followUp + triggerTurn)
      pi.sendMessage(message as never, options as never);
    },
    publishTerminal: (task) => {
      eventService.publishTerminal(task);
    },
  });
  setSharedTaskRegistry(registry);

  // Turn-arbiter wait source (lead only): while a task that will wake the
  // agent is still running, a nudge would race the wake — defer to it.
  if (!isChildProcess()) {
    try {
      registerWaitSource("background-tasks", () => pendingWakeReason(registry.allTasks()));
    } catch {
      // Registration must never block module load.
    }
  }

  const eventService: BackgroundTaskExtensionService = installBackgroundTaskExtensionApi({
    events: pi.events,
    registry,
    getContext: () => currentCtx,
    isShuttingDown: () => registry.isShuttingDown(),
  });

  function unseenFinishedTasks(): BgTask[] {
    return registry
      .allTasks()
      .filter((task) => task.status !== "running" && !seenTaskIds.has(task.id));
  }

  function clearFinishedNotices(ctx?: ExtensionContext): number {
    const unseen = unseenFinishedTasks();
    for (const task of unseen) seenTaskIds.add(task.id);
    updateUi(ctx);
    return unseen.length;
  }

  function updateUi(ctx?: ExtensionContext): void {
    if (registry.isShuttingDown()) return;
    const target = ctx ?? currentCtx;
    if (!target) return;
    try {
      if (!target.hasUI) return;
      const allTasks = registry.allTasks();
      const running = allTasks.filter((task) => task.status === "running");
      const unseenFailed = allTasks.filter((task) => task.status === "failed" && !seenTaskIds.has(task.id));
      const unseenStopped = allTasks.filter((task) => task.status === "killed" && !seenTaskIds.has(task.id));
      const unseenDone = allTasks.filter((task) => task.status === "completed" && !seenTaskIds.has(task.id));
      const unseenFinishedCount = unseenFailed.length + unseenStopped.length + unseenDone.length;

      // Pending-wake indicator. When the agent is idle but a bg task that will
      // wake it is still running, the UI otherwise looks finished and users
      // assume the turn is over. Install a self-animating spinner line above
      // the editor ONCE while any such task exists (the widget owns its 80 ms
      // frame timer and re-reads the registry on every frame, so this 1 s
      // poll only decides whether the widget exists — never its animation).
      const isIdle = () => {
        try {
          return target.isIdle();
        } catch {
          return true;
        }
      };
      const wantWakeLine = pendingWakeText(registry, isIdle) !== undefined;
      if (wantWakeLine && !wakeLineInstalled) {
        target.ui.setWidget(
          "background-tasks",
          createSpinnerLine({
            text: () => pendingWakeText(registry, isIdle),
            colorSpinner: (g: string) => `\x1b[38;5;82m${g}\x1b[0m`,
          }),
          { placement: "aboveEditor" },
        );
        wakeLineInstalled = true;
        // The pane is not done: a running task will re-invoke the agent. The
        // herdr `working` claim for this (UNI-162) is no longer made HERE —
        // the core pending-work monitor (installPendingWorkMonitor) reads the
        // "background-tasks" wait source (registerWaitSource above) and makes
        // ONE claim covering bg wake + subagents + fusion handoffs together,
        // instead of each owner claiming its own herdr key.
      } else if (!wantWakeLine && wakeLineInstalled) {
        target.ui.setWidget("background-tasks", undefined);
        wakeLineInstalled = false;
      }
      if (running.length === 0 && unseenFinishedCount === 0) {
        target.ui.setStatus("background-tasks", undefined);
        return;
      }

      const parts: string[] = [];
      if (running.length > 0) parts.push(`${String(running.length)} running`);
      if (unseenFailed.length > 0) parts.push(`${String(unseenFailed.length)} failed`);
      if (unseenStopped.length > 0) parts.push(`${String(unseenStopped.length)} stopped`);
      if (unseenDone.length > 0) parts.push(`${String(unseenDone.length)} done`);
      const entryHint = dockOpen ? "focused" : `Shift↓${unseenFinishedCount > 0 ? " · Ctrl+Alt+C clear" : ""}`;
      const label = ` bg ${[...parts, entryHint].join(" · ")} `;
      target.ui.setStatus("background-tasks", label);
    } catch (error) {
      console.error(
        `[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      currentCtx = undefined;
    }
  }

  async function startTask(ctx: ExtensionContext, command: string, opts: StartTaskOptions = {}): Promise<BgTask> {
    currentCtx = ctx;
    return registry.startTask(ctx, command, opts);
  }

  async function openTaskManager(ctx: ExtensionContext, initialTaskId?: string): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Background task manager requires an interactive UI. Use the bg_status/bg_logs tools in non-interactive mode.",
        "error",
      );
      return;
    }
    dockOpen = true;
    updateUi(ctx);
    try {
      // Task manager overlay on our slot patterns — dynamic import keeps the
      // component tree lazy. FleetView-style: bottom-center anchored overlay.
      const { BackgroundTasksManager } = await import("./task-manager.js");
      await ctx.ui.custom<"closed">(
        (tui, theme, _keybindings, done) =>
          new BackgroundTasksManager(tui, theme, done, {
            getTasks: () => registry.allTasks(),
            stopTask: async (task) => {
              await registry.stopTask(registry.resolveTask(task.id), "user");
              updateUi(ctx);
            },
            stopAllRunning: async () => {
              const result = await registry.stopAllRunning("user");
              updateUi(ctx);
              return result;
            },
            rerunTask: async (task) => {
              const rerunOptions: StartTaskOptions = {
                name: taskDisplayName(task),
                isAgent: task.isAgent,
                notifyOnCompletion: true,
                triggerOnCompletion: false,
              };
              if (task.description !== undefined) rerunOptions.description = task.description;
              if (task.timeoutSeconds !== undefined) rerunOptions.timeoutSeconds = task.timeoutSeconds;
              const rerun = await startTask(ctx, task.command, rerunOptions);
              updateUi(ctx);
              return rerun;
            },
            showOutputPath: (task) => {
              ctx.ui.notify(`Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`, "info");
            },
            markSeen: (taskId: string) => {
              seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            markFinishedSeen: (taskIds: string[]) => {
              for (const taskId of taskIds) seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            isSeen: (taskId: string) => seenTaskIds.has(taskId),
            ...(initialTaskId ? { initialTaskId } : {}),
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "96%",
            minWidth: 64,
            maxHeight: "60%",
            margin: { bottom: 1, left: 1, right: 1 },
          } as never,
        },
      );
    } finally {
      dockOpen = false;
      updateUi(ctx);
    }
  }

  registerToolsAndCommands({
    pi,
    registry,
    startTask,
    openTaskManager,
    clearFinishedNotices,
  });

  // Core handoff adapter: when pi's bash tool decides a running command
  // should move to the background (watchdog-driven or otherwise), core calls
  // this callback with the already-running child. We adopt it as a standard
  // background task via `adoptRunningProcess` and mark it watchdogAdopted so
  // the watchdog itself skips automatic kills on the now-registry-owned task.
  function bashBackgroundAdopter(request: BashBackgroundRequest): Promise<BashDetachResult | null> {
    const ctx = currentCtx;
    if (!ctx) return Promise.resolve(null);
    return registry
      .adoptRunningProcess(ctx, request.child, {
        command: request.command,
        stop: request.stop,
        startTime: request.startTime,
        initialOutput: request.initialOutput,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      })
      .then((task) => {
        updateUi(ctx);
        return { taskId: task.id, outputPath: task.outputPath };
      })
      .catch((error: unknown) => {
        console.error(
          `[background-tasks] bash background adoption failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
  }

  pi.on("session_start", async (_event, ctx) => {
    registry.setShuttingDown(false);
    wakeLineInstalled = false; // pi clears extension widgets on reload/new session
    setSharedTaskRegistry(registry);
    currentCtx = ctx;
    await registry.ensureRuntimeDir(ctx);
    setBashBackgroundAdopter(bashBackgroundAdopter);
    updateUi(ctx);
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => {
      updateUi();
    }, STATUS_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    registry.setShuttingDown(true);
    wakeLineInstalled = false;
    clearSharedTaskRegistry();
    setBashBackgroundAdopter(null);
    currentCtx = undefined;
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = undefined;
    }
    try {
      const running = registry.allTasks().filter((task) => task.status === "running");
      if (running.length === 0) return;

      const failures: string[] = [];
      await Promise.all(
        running.map(async (task) => {
          try {
            await registry.stopTask(task, "shutdown", "Killed during Pi session shutdown/reload");
          } catch (error) {
            const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
            failures.push(message);
            console.error(`[background-tasks] shutdown cleanup failed for ${message}`);
          }
        }),
      );
      if (failures.length > 0 && ctx.hasUI) {
        ctx.ui.notify(`Background task cleanup failed:\n${failures.join("\n")}`, "error");
      }
    } finally {
      eventService.close();
    }
  });
}
