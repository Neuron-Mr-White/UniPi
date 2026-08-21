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
import { loadBackgroundTasksConfig } from "./config.js";
import { BackgroundTaskRegistry } from "./registry.js";
import {
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionService,
} from "./extension-api.js";
import { registerToolsAndCommands } from "./tools.js";
import { registerFusionExtension } from "./fusion-extension.js";
import { registerDelegateExtension } from "./delegate-extension.js";
import { taskDisplayName, type BgTask, type StartAttestedPiTaskOptions, type StartTaskOptions } from "./types.js";

const STATUS_INTERVAL_MS = 1000;

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
  let statusInterval: NodeJS.Timeout | undefined;

  const registry = new BackgroundTaskRegistry({
    maxOutputBytes: config.maxOutputBytes,
    maxRecentTasks: config.maxFinishedTasks,
    onChange: () => {
      updateUi();
    },
    sendCompletionNotification: (message, options) => {
      // Our sendMessage path (same contract as reference; pi delivers followUp + triggerTurn)
      pi.sendMessage(message as never, options as never);
    },
    publishTerminal: (task) => {
      eventService.publishTerminal(task);
    },
  });
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

      target.ui.setWidget("background-tasks", undefined);
      if (running.length === 0 && unseenFinishedCount === 0) {
        target.ui.setStatus("background-tasks", undefined);
        return;
      }

      const parts: string[] = [];
      if (running.length > 0) parts.push(`${String(running.length)} running`);
      if (unseenFailed.length > 0) parts.push(`${String(unseenFailed.length)} failed`);
      if (unseenStopped.length > 0) parts.push(`${String(unseenStopped.length)} stopped`);
      if (unseenDone.length > 0) parts.push(`${String(unseenDone.length)} done`);
      const entryHint = dockOpen ? "focused" : `Shift↓${unseenFinishedCount > 0 ? " · /unipi:bg-clear" : ""}`;
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

  async function startAttestedPiTask(
    ctx: ExtensionContext,
    opts: StartAttestedPiTaskOptions,
  ): Promise<BgTask> {
    currentCtx = ctx;
    return registry.startAttestedPiTask(ctx, opts);
  }

  async function openTaskManager(ctx: ExtensionContext, initialTaskId?: string): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Background task manager requires an interactive UI. Use /unipi:jobs, /unipi:logs, or the bg_status/bg_logs tools in non-interactive mode.",
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
              if (task.fusion !== undefined || task.delegate !== undefined) {
                throw new Error(
                  "Only shell-command tasks can be rerun from the dock; relaunch this typed workflow through its owning tool.",
                );
              }
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

  async function openSettings(ctx: ExtensionContext): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Background-tasks settings require an interactive UI. Edit ~/.unipi/config/background-tasks.json directly instead.",
        "error",
      );
      return;
    }
    const { renderBackgroundTasksSettingsOverlay } = await import("./settings-overlay.js");
    await ctx.ui.custom(
      renderBackgroundTasksSettingsOverlay({ cwd: ctx.cwd ?? process.cwd() }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "70%",
          minWidth: 56,
          margin: 2,
        } as never,
      },
    );
  }

  registerToolsAndCommands({
    pi,
    registry,
    startTask,
    startAttestedPiTask,
    openTaskManager,
    clearFinishedNotices,
    openSettings,
  });

  registerFusionExtension(pi, {
    startManagedTask: async (ctx, options) => {
      currentCtx = ctx;
      return registry.startManagedTask(ctx, options);
    },
    snapshot: (task) => registry.snapshot(task),
    updateManagedTask: (task, state, line) => registry.updateManagedTask(task, state, line),
  });

  registerDelegateExtension(pi, {
    startDelegateTask: async (ctx, options) => {
      currentCtx = ctx;
      return registry.startDelegateTask(ctx, options);
    },
    snapshot: (task) => registry.snapshot(task),
    resolveTask: (idOrPrefix) => registry.resolveTask(idOrPrefix),
    claimFusionUsage: (task) => registry.claimFusionUsage(task),
  });

  pi.on("session_start", async (_event, ctx) => {
    registry.setShuttingDown(false);
    currentCtx = ctx;
    await registry.ensureRuntimeDir(ctx);
    updateUi(ctx);
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => {
      updateUi();
    }, STATUS_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    registry.setShuttingDown(true);
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
