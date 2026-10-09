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
  isChildProcess,
  openWorkTray,
  registerWaitSource,
  registerWorkTrayTab,
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
import { taskDisplayName, type BgTask, type StartTaskOptions } from "./types.js";
import { BackgroundTasksManager, type TaskManagerTheme } from "./task-manager.js";

// Direct synchronous access for sibling extensions (footer process one-liner).
export { getSharedTaskRegistry } from "./registry-shared.js";

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

  const registry = new BackgroundTaskRegistry({
    maxOutputBytes: config.maxOutputBytes,
    maxRecentTasks: config.maxFinishedTasks,
    onChange: () => {
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

  /** The work tray (UNI-126) re-renders off the registry change signal
   *  and owns the strip, so the old status label + "waiting on N bg tasks"
   *  wake line are gone: the footer's UNI-162 "waiting on …" line already
   *  reads this module's wait source (registerWaitSource above). This only
   *  remembers the context the tray's pane actions need. */
  function updateUi(ctx?: ExtensionContext): void {
    if (ctx) currentCtx = ctx;
  }

  async function startTask(ctx: ExtensionContext, command: string, opts: StartTaskOptions = {}): Promise<BgTask> {
    currentCtx = ctx;
    return registry.startTask(ctx, command, opts);
  }

  function createPane(ctx: ExtensionContext | undefined, close: () => void, tui: { requestRender(): void }, theme: TaskManagerTheme, initialTaskId?: string): BackgroundTasksManager {
    return new BackgroundTasksManager(tui, theme, () => close(), {
      getTasks: () => registry.allTasks(),
      stopTask: async (task) => {
        await registry.stopTask(registry.resolveTask(task.id), "user");
      },
      stopAllRunning: async () => registry.stopAllRunning("user"),
      rerunTask: async (task) => {
        const target = ctx ?? currentCtx;
        if (!target) throw new Error("No active session to rerun in.");
        const rerunOptions: StartTaskOptions = {
          name: taskDisplayName(task),
          isAgent: task.isAgent,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (task.description !== undefined) rerunOptions.description = task.description;
        if (task.timeoutSeconds !== undefined) rerunOptions.timeoutSeconds = task.timeoutSeconds;
        return startTask(target, task.command, rerunOptions);
      },
      showOutputPath: (task) => {
        (ctx ?? currentCtx)?.ui.notify(`Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`, "info");
      },
      markSeen: (taskId: string) => {
        seenTaskIds.add(taskId);
      },
      markFinishedSeen: (taskIds: string[]) => {
        for (const taskId of taskIds) seenTaskIds.add(taskId);
      },
      isSeen: (taskId: string) => seenTaskIds.has(taskId),
      ...(initialTaskId ? { initialTaskId } : {}),
    });
  }

  // One bottom pane with the subagents (UNI-126): this is its first tab.
  registerWorkTrayTab(pi, {
    id: "bg",
    label: "Background tasks",
    shortLabel: "Bg tasks",
    order: 0,
    counts: () => {
      const all = registry.allTasks();
      return { total: all.length, running: all.filter((task) => task.status === "running").length };
    },
    createPane: ({ tui, theme, close, initialId }) => createPane(currentCtx, close, tui, theme, initialId),
  });

  async function openTaskManager(ctx: ExtensionContext, initialTaskId?: string): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Background task manager requires an interactive UI. Use the bg_status/bg_logs tools in non-interactive mode.",
        "error",
      );
      return;
    }
    await openWorkTray(ctx, { tab: "bg", ...(initialTaskId ? { initialId: initialTaskId } : {}) });
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
    setSharedTaskRegistry(registry);
    currentCtx = ctx;
    await registry.ensureRuntimeDir(ctx);
    setBashBackgroundAdopter(bashBackgroundAdopter);
    updateUi(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    registry.setShuttingDown(true);
    clearSharedTaskRegistry();
    setBashBackgroundAdopter(null);
    currentCtx = undefined;
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
