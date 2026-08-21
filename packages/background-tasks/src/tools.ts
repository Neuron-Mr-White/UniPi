/**
 * @pi-unipi/background-tasks — Tools & commands (Phase 2)
 *
 * Ported from pi-background-tasks src/extension.ts tool/command registration.
 * Commands live in OUR /unipi:* namespace; tools keep reference names.
 */

import { Text } from "@earendil-works/pi-tui";
import { getInstalledPackageVersion } from "@pi-unipi/core";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
  COMMAND_PREVIEW_CHARS,
  DEFAULT_LOG_BYTES,
  MAX_LOG_BYTES,
  deriveCompletionDeliveryGuidance,
  deriveTaskNameFromCommand,
  formatSnapshotList,
  normalizeMaxBytes,
  normalizeTaskName,
  parseBgCommandArgs,
  taskDisplayName,
  truncateChars,
  type BgKillDetails,
  type BgLogsDetails,
  type BgRunDetails,
  type BgStatusDetails,
  type BgTaskSnapshot,
  type StartAttestedPiTaskOptions,
  type StartTaskOptions,
} from "./types.js";
import type { BackgroundTaskRegistry } from "./registry.js";

export function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text }];
}

// ── Tool parameter schemas ──────────────────────────────────────────────────

export const BgRunParams = Type.Object({
  name: Type.String({
    description:
      "Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.",
  }),
  command: Type.String({ description: "Shell command to start in the background" }),
  isAgent: Type.Boolean({
    description:
      "True ONLY when the command launches an LLM/agent process (enables telemetry wrapping). False for scripts, tests, servers, sleeps.",
  }),
  description: Type.Optional(Type.String({ description: "Longer human-readable description" })),
  timeoutSeconds: Type.Optional(
    Type.Number({ description: "Kill the task after this many seconds (optional)" }),
  ),
  notifyOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        "Deliver a durable terminal notification when the task finishes. Default true. Do not disable unless opting out of completion handling.",
    }),
  ),
  triggerOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        "Start a follow-up agent turn on terminal notification. Default true for bg_run. Requires notifyOnCompletion.",
    }),
  ),
});

export const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({ description: "Task ID or unambiguous prefix. Omit to list all tasks." }),
  ),
});

export const BgLogsParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes of output to return (1-${String(MAX_LOG_BYTES)}). Default ${String(DEFAULT_LOG_BYTES)}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({ description: "Read from the end (tail, default true) or the beginning (head)" }),
  ),
});

export const BgKillParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix of a running task" }),
});

export const BgPiAttestedParams = Type.Object({
  name: Type.String({ description: "Short human-readable task name" }),
  provider: Type.String({ description: "Pi provider id (e.g. anthropic)" }),
  model: Type.String({ description: "Model id under the provider" }),
  prompt: Type.String({ description: "Final user prompt for the child Pi run" }),
  reportPath: Type.String({
    description: "Relative path (inside cwd) where the child must write its report before exit",
  }),
  extraPiArgs: Type.Optional(
    Type.Array(Type.String(), { description: "Extra literal pi CLI args (restricted)" }),
  ),
  thinking: Type.Optional(Type.String({ description: "Thinking level passed as --thinking" })),
  timeoutSeconds: Type.Optional(Type.Number({ description: "Kill after this many seconds" })),
});

// ── Registration ────────────────────────────────────────────────────────────

export interface RegisterSurfaceOptions {
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
  registry: BackgroundTaskRegistry;
  startTask: (ctx: any, command: string, options?: StartTaskOptions) => Promise<any>;
  startAttestedPiTask: (
    ctx: any,
    options: StartAttestedPiTaskOptions,
  ) => Promise<any>;
  openTaskManager: (ctx: any, initialTaskId?: string) => Promise<void>;
  clearFinishedNotices: (ctx: any) => number;
  openSettings: (ctx: any) => Promise<void>;
}

function renderPlainResult(
  result: { content: ReadonlyArray<{ type: string; text?: string }> },
  _options: unknown,
  theme: any,
): Text {
  const text = result.content
    .map((content) => (content.type === "text" ? (content.text ?? "") : "[image content]"))
    .join("\n");
  return new Text(theme.fg("toolOutput", text), 0, 0);
}

/** Register all bg_* tools + /unipi:* commands + shortcuts. */
export function registerToolsAndCommands(options: RegisterSurfaceOptions): void {
  const { pi, registry } = options;

  // ── Commands (/unipi:* namespace — ours) ──────────────────────────────────

  // Update info lives with OUR updater module; this only reports versions.
  pi.registerCommand("unipi:bg-update", {
    description: "Show the installed background-tasks version and how to update",
    handler: (_args, ctx) => {
      const here = dirname(fileURLToPath(import.meta.url));
      const current = getInstalledPackageVersion(here, "@pi-unipi/background-tasks");
      const lines = [
        `@pi-unipi/background-tasks ${current} is installed.`,
        "Background tasks ship inside the @pi-unipi/unipi umbrella package.",
        "Update from npm:",
        "  pi install npm:@pi-unipi/unipi@latest",
        "Or use /unipi:updater-settings to check for updates.",
        "This command only prints update instructions; it does not install or self-update.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand("unipi:bg", {
    description:
      'Start a shell command as a tracked background task: /unipi:bg [--agent] [--name "Task name"] <command>',
    handler: async (args, ctx) => {
      try {
        const parsed = parseBgCommandArgs(args);
        const taskOptions: StartTaskOptions = {
          isAgent: parsed.isAgent,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (parsed.name !== undefined) taskOptions.name = parsed.name;
        const task = await options.startTask(ctx, parsed.command, taskOptions);
        ctx.ui.notify(
          `Started ${taskDisplayName(task)} (${task.id})\nOutput: ${task.outputPath}\nCommand: ${task.command}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Background task failed to start: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("unipi:tasks", {
    description: "Open the background task manager UI",
    handler: async (args, ctx) => {
      const taskId = typeof args === "string" ? args.trim() : "";
      await options.openTaskManager(ctx, taskId || undefined);
    },
  });

  pi.registerCommand("unipi:bg-clear", {
    description: "Clear finished background task footer notices",
    handler: (_args, ctx) => {
      options.clearFinishedNotices(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("unipi:jobs", {
    description: "List running and recent background tasks",
    handler: (_args, ctx) => {
      ctx.ui.notify(
        formatSnapshotList(registry.allTasks().map((task) => registry.snapshot(task))),
        "info",
      );
      return Promise.resolve();
    },
  });

  pi.registerCommand("unipi:logs", {
    description: "Show bounded output from a background task: /unipi:logs <id> [maxBytes]",
    getArgumentCompletions: (prefix: string) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        const [id, bytes] = args.trim().split(/\s+/, 2);
        const task = registry.resolveTask(id ?? "");
        const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
        const logs = await registry.getTaskLogs(task, maxBytes, true);
        ctx.ui.notify(logs.text, "info");
      } catch (error) {
        ctx.ui.notify(
          `Background logs error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("unipi:kill", {
    description: "Stop a running background task: /unipi:kill <id>",
    getArgumentCompletions: (prefix: string) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.status === "running" && task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: truncateChars(task.command, 70),
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        const task = registry.resolveTask(args.trim());
        await registry.stopTask(task, "user");
        ctx.ui.notify(
          `Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Background kill error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  // Shortcuts (same keys as reference; documented in our README)
  pi.registerCommand("unipi:bg-settings", {
    description: "Open background-tasks settings (master toggle, defaults)",
    handler: async (_args, ctx) => {
      await options.openSettings(ctx);
    },
  });

  pi.registerShortcut("shift+down" as never, {
    description: "Open focused background task footer dock",
    handler: async (ctx) => {
      await options.openTaskManager(ctx);
    },
  });
  pi.registerShortcut("ctrl+alt+c" as never, {
    description: "Clear finished background task footer notices",
    handler: (ctx) => {
      options.clearFinishedNotices(ctx);
    },
  });

  // ── Notification renderer ────────────────────────────────────────────────

  pi.registerMessageRenderer<BgTaskSnapshot>(
    "background-task-notification",
    (message: { details?: BgTaskSnapshot }, _options: unknown, theme: any) => {
      const task = message.details;
      const status = task?.status ?? "completed";
      const color: string =
        status === "completed" ? "success" : status === "failed" ? "error" : status === "killed" ? "warning" : "accent";
      const id = task?.id ?? "background task";
      const name = task ? taskDisplayName(task) : "Background task";
      const output = task?.outputPath ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}` : "";
      const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
      return new Text(
        `${theme.fg(color, `[bg ${status}]`)} ${theme.fg("accent", name)} ${theme.fg("dim", `(${id})`)}${output}${error}`,
        0,
        0,
      );
    },
  );

  // ── Tools (reference names kept) ─────────────────────────────────────────

  pi.registerTool<typeof BgRunParams, BgRunDetails>({
    name: "bg_run",
    label: "Background Run",
    description: `Start a named long-running shell command in the background and return immediately with a task ID and output path. By default, terminal state is delivered automatically as <background-task-notification> and starts a follow-up agent turn; do not sleep or poll merely to wait. Output is written under the OS temp root and model-visible logs are bounded.`,
    promptSnippet:
      "Start a named long-running shell command; default terminal notification wakes a follow-up turn, so yield instead of polling",
    promptGuidelines: [
      "Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, or builds.",
      "Set isAgent:true only when the background task launches an LLM/agent process; false for scripts, tests, dev servers, sleeps.",
      "Always set name to a concise 2-6 word human-readable label; do not use the raw command as the name.",
      "After a default bg_run launch, continue only independent useful work; otherwise end the turn and wait for <background-task-notification>.",
      "Treat <background-task-notification> as durable terminal truth. Do not call bg_status to reconfirm it.",
      "Do not set notifyOnCompletion:false or triggerOnCompletion:false unless intentionally opting out.",
    ],
    parameters: BgRunParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (typeof params.isAgent !== "boolean") {
        throw new Error(
          "bg_run requires isAgent boolean. Set true only for LLM/agent tasks; set false for scripts, tests, servers, sleeps.",
        );
      }
      const taskOptions: StartTaskOptions = {
        name: params.name,
        isAgent: params.isAgent,
        notifyOnCompletion: params.notifyOnCompletion ?? true,
        triggerOnCompletion: params.triggerOnCompletion ?? true,
      };
      if (params.description !== undefined) taskOptions.description = params.description;
      if (params.timeoutSeconds !== undefined) taskOptions.timeoutSeconds = params.timeoutSeconds;
      const task = await options.startTask(ctx, params.command, taskOptions);
      const completionDelivery = deriveCompletionDeliveryGuidance(
        task.notifyOnCompletion,
        task.triggerOnCompletion,
      );
      return {
        content: textContent(
          `Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? "unknown")}\nOutput: ${task.outputPath}\n${completionDelivery.text}`,
        ),
        details: { task: registry.snapshot(task) },
      };
    },
    renderCall(args: Static<typeof BgRunParams>, theme: any) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_run "))}${theme.fg("muted", truncateChars(taskDisplayName(args), COMMAND_PREVIEW_CHARS))}`,
        0,
        0,
      );
    },
    renderResult(result: { details: BgRunDetails }, _options: unknown, theme: any) {
      const { task } = result.details;
      return new Text(
        `${theme.fg("success", "✓ started")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
    name: "bg_status",
    label: "Background Status",
    description:
      "Inspect one background task or list all running/recent background tasks. Point-in-time inspection tool, not a waiting primitive.",
    promptSnippet:
      "Inspect point-in-time status for one or all background tasks; never poll it as a wait loop",
    promptGuidelines: [
      "Use bg_status for deliberate point-in-time inspection, not as a waiting primitive.",
      "A running result is not an instruction to poll again.",
      "Use bg_status when the user explicitly requests an update, automatic completion handling was disabled, or there is concrete evidence a task is hung.",
    ],
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      const selected = params.taskId ? [registry.resolveTask(params.taskId)] : registry.allTasks();
      const snapshots = selected.map((task) => registry.snapshot(task));
      return Promise.resolve({
        content: textContent(formatSnapshotList(snapshots)),
        details: { tasks: snapshots },
      });
    },
    renderCall(args: Static<typeof BgStatusParams>, theme: any) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_status"))}${args.taskId ? ` ${theme.fg("accent", args.taskId)}` : ""}`,
        0,
        0,
      );
    },
    renderResult: renderPlainResult,
  });

  pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
    name: "bg_logs",
    label: "Background Logs",
    description:
      "Read bounded output from a background task for deliberate inspection; not a waiting primitive. Output is capped for model safety and points to the full output file when truncated.",
    promptSnippet: "Read bounded task output when needed; never tail it repeatedly as a wait loop",
    promptGuidelines: [
      "Use bg_logs with a modest maxBytes value only when task output is needed.",
      "Do not repeatedly call bg_logs to wait for completion while an automatic terminal notification is pending.",
    ],
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      const logs = await registry.getTaskLogs(
        task,
        normalizeMaxBytes(params.maxBytes),
        params.tail ?? true,
      );
      return {
        content: textContent(logs.text),
        details: logs.details,
      };
    },
    renderCall(args: Static<typeof BgLogsParams>, theme: any) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_logs "))}${theme.fg("accent", args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result: { details: BgLogsDetails; content: ReadonlyArray<{ type: string; text?: string }> }, options: { expanded?: boolean }, theme: any) {
      const details = result.details;
      let text = `${theme.fg("accent", taskDisplayName(details.task))} ${theme.fg("dim", `(${details.task.id})`)} ${theme.fg("muted", details.tail ? "tail" : "head")} ${details.bytesRead}`;
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      text += `\n${theme.fg("dim", `Full output: ${details.path}`)}`;
      if (options.expanded) {
        const output = result.content
          .map((content) => (content.type === "text" ? (content.text ?? "") : "[image content]"))
          .join("\n");
        text += `\n${theme.fg("toolOutput", output.split("\n").slice(0, 30).join("\n"))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<typeof BgKillParams, BgKillDetails>({
    name: "bg_kill",
    label: "Background Kill",
    description:
      "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
    promptSnippet: "Stop a running background task by ID",
    promptGuidelines: [
      "Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed.",
    ],
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      await registry.stopTask(task, "user");
      const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
      return {
        content: textContent(message),
        details: { task: registry.snapshot(task), message },
      };
    },
    renderCall(args: Static<typeof BgKillParams>, theme: any) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_kill "))}${theme.fg("accent", args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result: { details: BgKillDetails }, _options: unknown, theme: any) {
      const { task } = result.details;
      return new Text(
        `${theme.fg("warning", "■ killed")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof BgPiAttestedParams, BgRunDetails>({
    name: "bg_run_pi_attested",
    label: "Attested Pi Run",
    description:
      "Opt-in evidence-oriented direct Pi spawn. Launches exactly one `pi --mode json` child, records raw events/stderr, hashes prompt/report/output, observes OAuth through ModelRegistry, and emits a strict attestation sidecar only after successful completion.",
    promptSnippet: "Start an attested direct Pi agent task and return its task ID plus output path",
    promptGuidelines: [
      "Use only when the user explicitly asks for an attested Pi evidence-producing task; ordinary background work should use bg_run unchanged.",
      "Provide provider/model as structured fields and a relative reportPath that the child Pi prompt will write before exit.",
      "Do not provide channel, auth, route, or hash claims; the producer observes those facts itself and fails loudly if it cannot attest them.",
    ],
    parameters: BgPiAttestedParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const task = await options.startAttestedPiTask(ctx, params);
      return {
        content: textContent(
          `Started attested Pi task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? "unknown")}\nOutput: ${task.outputPath}\nAttestation: ${task.attestationPath ?? "pending until completion"}`,
        ),
        details: { task: registry.snapshot(task) },
      };
    },
    renderCall(args: Static<typeof BgPiAttestedParams>, theme: any) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_run_pi_attested "))}${theme.fg("muted", truncateChars(args.name, COMMAND_PREVIEW_CHARS))}`,
        0,
        0,
      );
    },
    renderResult(result: { details: BgRunDetails }, _options: unknown, theme: any) {
      const { task } = result.details;
      return new Text(
        `${theme.fg("success", "✓ started")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}\n${theme.fg("dim", `Attestation: ${task.attestationPath ?? "pending"}`)}`,
        0,
        0,
      );
    },
  });
}
