/**
 * @pi-unipi/kanboard — pi extension.
 *
 * Bridges the terminal to the board: `/unipi:kanboard` (open/close/onboard/
 * status/doctor — bare lists the commands), `/unipi:kanboard-add`,
 * `/unipi:kanboard-do` (opens the board-write window for one turn),
 * `/unipi:kanboard-autowork` (the runner loop: queue first, then claim-next).
 * The runner owns claim → In Progress and run-end → In Review. The board itself
 * is written by the Rust binary (`crates/kanboard`); this extension never edits
 * task files. Bash calls into the binary are gated by the write window
 * (src/guard.ts): reads always pass, writes need a -do turn or a running task.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MODULES,
  UNIPI_EVENTS,
  emitEvent,
  getPackageVersion,
  initUnipiDirs,
  registerCommandRunner,
  getSettings,
} from "@pi-unipi/core";

import { openCli, type KanboardCli } from "./src/bin.js";
import { createWriteGuard } from "./src/guard.js";
import {
  drainQueueAfterDo,
  registerKanboardCommands,
  runOpen,
  syncPiRuntime,
  runRotateTokenAction,
  runStopDaemon,
  type CommandDeps,
} from "./src/commands.js";
import { createDebugLog, createRunner, registerPlanEventListener, type Runner } from "./src/runner.js";
import {
  ACTION_OPEN,
  ACTION_STOP_DAEMON,
  ACTION_ROTATE_TOKEN,
  readKanboardSettings,
  registerKanboardSettings,
  applyLimitEnv,
} from "./src/settings.js";

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Utility owns the frozen judged set, so kanboard asks it to reveal the skill. */
export const SKILL_REVEAL_EVENT = "unipi:skills:reveal";
export const KANBOARD_SKILL = "kanboard";

export default function (pi: ExtensionAPI) {
  // One session id shared by the runner and the agent's bash calls.
  process.env.UNIPI_KANBOARD_SESSION ??= `pi-${process.pid}`;
  // Limits travel through the environment; refresh on load and before every
  // tool_call (see the guard registration in commands.ts).
  applyLimitEnv(readKanboardSettings());
  const debug = createDebugLog();
  registerKanboardSettings();

  let cli: KanboardCli | null = null;
  let unavailable: string | null = null;
  let runner: Runner | null = null;
  const guard = createWriteGuard(
    () => {
      const status = runner?.status();
      return status?.phase === "running" ? status.taskId : null;
    },
    () => readKanboardSettings().turnAddLimit,
  );
  const sessionId = (): string => process.env.UNIPI_KANBOARD_SESSION ?? `pi-${process.pid}`;

  const projectSlug = (): string => {
    const fromEnv = process.env.UNIPI_KANBOARD_PROJECT?.trim();
    if (fromEnv) return fromEnv;
    try {
      const settings = getSettings("kanboard", process.cwd()) as { slug?: string };
      return typeof settings.slug === "string" ? settings.slug : "";
    } catch {
      return "";
    }
  };

  // Live getters: the command is registered before the binary is resolved, so
  // the deps object must read the current state at call time.
  const buildDeps = (): CommandDeps => ({
      get cli() {
        return cli;
      },
      get unavailable() {
        return unavailable;
      },
      settings: () => readKanboardSettings(process.cwd()),
      revealSkill,
      work: (ctx) => runner?.work(ctx) ?? Promise.resolve(),
      stop: (ctx) => runner?.stop(ctx),
      drainQueue: (ctx) => runner?.drain(ctx) ?? Promise.resolve(),
      status: () => runner?.status() ?? { taskId: null, mode: null, phase: "idle" },
      guard,
      session: sessionId,
      debug,
    }) as CommandDeps;

  const revealSkill = (ctx: ExtensionContext | { cwd?: string }): void => {
    // Append-only reveal (never the system prompt), so the prefix cache holds.
    emitEvent(pi, SKILL_REVEAL_EVENT, { names: [KANBOARD_SKILL], ctx });
    debug(`reveal requested for ${KANBOARD_SKILL}`);
  };

  const attach = (ctx: ExtensionContext): boolean => {
    if (cli) return true;
    const opened = openCli();
    if ("error" in opened) {
      unavailable = opened.error;
      return false;
    }
    cli = opened;
    unavailable = null;
    debug(`binary: ${opened.binary.path} (${opened.binary.source})`);
    if (!runner) {
      runner = createRunner({
        pi,
        cli,
        project: projectSlug,
        cwd: ctx.cwd,
        settings: () => readKanboardSettings(ctx.cwd),
        debug,
      });
      registerPlanEventListener(pi, runner);
    }
    return true;
  };

  registerKanboardCommands(pi, buildDeps());

  registerCommandRunner(ACTION_OPEN, async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    if (!context?.ui) return;
    if (!attach(context)) {
      context.ui.notify(`kanboard: ${unavailable}`, "warning");
      return;
    }
    await runOpen(buildDeps(), context);
  });

  registerCommandRunner(ACTION_STOP_DAEMON, async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    if (!context?.ui) return;
    await runStopDaemon(buildDeps(), context);
  });

  registerCommandRunner(ACTION_ROTATE_TOKEN, async (ctx) => {
    const context = ctx as ExtensionContext | undefined;
    if (!context?.ui) return;
    await runRotateTokenAction(buildDeps(), context);
  });

  pi.on("session_start", async (_event, ctx) => {
    initUnipiDirs();
    if (attach(ctx as unknown as ExtensionContext)) {
      const deps = buildDeps();
      if (deps.cli) void syncPiRuntime(deps, ctx as unknown as ExtensionContext);
    }
    emitEvent(pi, UNIPI_EVENTS.MODULE_READY, {
      name: MODULES.KANBOARD,
      version: VERSION,
      commands: ["kanboard"],
      tools: [],
    });

    if (!attach(ctx as unknown as ExtensionContext)) {
      debug(`unavailable: ${unavailable}`);
      return;
    }
    const client = cli!;
    const settings = readKanboardSettings(ctx.cwd);
    if (settings.archiveAfterDays > 0 || settings.retentionDays > 0) {
      // Fire and forget: sweeping must never delay startup.
      void client
        .run([
          "archive-sweep",
          "--after-days",
          String(settings.archiveAfterDays),
          "--retention-days",
          String(settings.retentionDays),
        ])
        .then((payload) => debug(`archive-sweep: ${JSON.stringify(payload)}`))
        .catch((error) => debug(`archive-sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    await runner?.onSessionStart(ctx as unknown as ExtensionContext);
  });

  let drainPending = false;
  pi.on("agent_end", async (event, ctx) => {
    runner?.onAgentEnd(event as { messages?: unknown[] }, ctx as unknown as ExtensionContext);
    // A -do window closes on the first real agent_end (the 150ms echo guard
    // inside onAgentEnd skips the previous turn's late end). The drain itself
    // runs at agent_settled: sending a task prompt while the turn is still
    // finalizing would queue it as a follow-up that never gets delivered.
    if (guard.onAgentEnd()) drainPending = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!drainPending) return;
    drainPending = false;
    await drainQueueAfterDo(buildDeps(), ctx as unknown as ExtensionContext);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runner?.onSessionShutdown(ctx as unknown as ExtensionContext);
  });
}
