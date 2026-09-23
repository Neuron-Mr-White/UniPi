/**
 * @pi-unipi/kanboard — pi extension.
 *
 * Bridges the terminal to the board: `/unipi:kanboard` (open/onboard/add/work/
 * stop/status), the runner that owns claim → In Progress and run-end → In Review,
 * the hub settings, and the kanboard skill. The board itself is written by the
 * Rust binary (`crates/kanboard`); this extension never edits task files.
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
import {
  registerKanboardCommand,
  runOpen,
  runStopDaemon,
  type CommandDeps,
} from "./src/commands.js";
import { createDebugLog, createRunner, registerPlanEventListener, type Runner } from "./src/runner.js";
import {
  ACTION_OPEN,
  ACTION_STOP_DAEMON,
  readKanboardSettings,
  registerKanboardSettings,
} from "./src/settings.js";

const VERSION = getPackageVersion(dirname(fileURLToPath(import.meta.url)));

/** Utility owns the frozen judged set, so kanboard asks it to reveal the skill. */
export const SKILL_REVEAL_EVENT = "unipi:skills:reveal";
export const KANBOARD_SKILL = "kanboard";

export default function (pi: ExtensionAPI) {
  const debug = createDebugLog();
  registerKanboardSettings();

  let cli: KanboardCli | null = null;
  let unavailable: string | null = null;
  let runner: Runner | null = null;

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
      status: () => runner?.status() ?? { taskId: null, mode: null, phase: "idle" },
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

  registerKanboardCommand(pi, buildDeps());

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

  pi.on("session_start", async (_event, ctx) => {
    initUnipiDirs();
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
    if (settings.archiveAfterDays > 0) {
      // Fire and forget: sweeping must never delay startup.
      void client
        .run(["archive-sweep", "--after-days", String(settings.archiveAfterDays)])
        .then((payload) => debug(`archive-sweep: ${JSON.stringify(payload)}`))
        .catch((error) => debug(`archive-sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    await runner?.onSessionStart(ctx as unknown as ExtensionContext);
  });

  pi.on("agent_end", async (event, ctx) => {
    runner?.onAgentEnd(event as { messages?: unknown[] }, ctx as unknown as ExtensionContext);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await runner?.onSessionShutdown(ctx as unknown as ExtensionContext);
  });
}
