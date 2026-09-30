/**
 * @pi-unipi/kanboard — pi extension.
 *
 * Bridges the terminal to the board: `/unipi:kanboard` (open/close/onboard/
 * status/doctor/show — bare lists the commands), `/unipi:kanboard-add`,
 * `/unipi:kanboard-do` (grants task slots + a write budget for one prompt),
 * `/unipi:kanboard-autowork` (work every ready task in this session). The
 * session works tasks itself — there is no runner. Continuation is the turn
 * arbiter's job: src/monitor.ts proposes at most one nudge per settle (claims
 * first, then the next ready autowork task). Bash calls into the Rust binary
 * are gated by src/guard.ts: reads always pass, children never write, writes
 * cost the -do budget (own-claim closes are free). The board itself is
 * written by the binary; this extension never edits task files.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  MODULES,
  UNIPI_EVENTS,
  emitEvent,
  getPackageVersion,
  getSettings,
  getSharedKanboardStatus,
  getSharedOwnerStatus,
  initUnipiDirs,
  isChildProcess,
  registerCommandRunner,
  registerEvidenceContributor,
  registerNudgeProvider,
  registerProgressRenderer,
  setSharedKanboardStatus,
  appendProgress,
} from "@pi-unipi/core";

import { openCli, type KanboardCli } from "./src/bin.js";
import { kanboardInvocations } from "./src/guard.js";
import { maybeBadgeToolResult, registerBadgeRenderer } from "./src/badges.js";
import {
  registerKanboardCommands,
  runOpen,
  syncPiRuntime,
  runRotateTokenAction,
  runStopDaemon,
  type CommandDeps,
} from "./src/commands.js";
import { createWriteGuard } from "./src/guard.js";
import { NOTICE_ENTRY, flushNotices, NoticeBuffer } from "./src/notice-buffer.js";
import { createKanboardMonitor } from "./src/monitor.js";
import { createDebugLog } from "./src/debug.js";
import { createProgressTracker, registerProgressReminders, ANTI_POISONING_SUFFIX } from "./src/reminders.js";
import { asTaskList, type KanboardTask } from "./src/shapes.js";
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
  // One session id shared by the agent's bash calls (refined at session_start
  // from the pi session id; children keep the value they inherited).
  process.env.UNIPI_KANBOARD_SESSION ??= `pi-${process.pid}`;
  // `start` claims belong to this pi process: the stale-claim reaper releases
  // them to Todo when it dies (the agent's bash inherits the env).
  process.env.UNIPI_KANBOARD_PID ??= String(process.pid);
  // Limits travel through the environment; refresh on load and before every
  // tool_call (see the guard registration in commands.ts).
  applyLimitEnv(readKanboardSettings());
  const debug = createDebugLog();
  registerKanboardSettings();

  let cli: KanboardCli | null = null;
  let unavailable: string | null = null;
  const guard = createWriteGuard({
    addLimit: () => readKanboardSettings().turnAddLimit,
    doTasks: () => readKanboardSettings().doTasks,
    doWrites: () => readKanboardSettings().doWrites,
  });
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

  // ── board reads (lead monitor/evidence/holder/notice) ────────────────
  const listTasks = async (args: string[] = []): Promise<KanboardTask[]> => {
    const client = cli;
    const slug = projectSlug();
    if (!client || !slug) return [];
    const payload = await client.run<unknown>(["list", ...args, "--json"], {
      extraEnv: { UNIPI_KANBOARD_PROJECT: slug, UNIPI_KANBOARD_SESSION: sessionId() },
    });
    return asTaskList(payload).tasks;
  };
  const ownClaims = async (): Promise<KanboardTask[]> => {
    try {
      const session = sessionId();
      return (await listTasks()).filter((task) => {
        const run = task.run as { session?: string } | null | undefined;
        return task.status === "in_progress" && run?.session === session;
      });
    } catch {
      return [];
    }
  };

  // ── monitor: the arbiter's kanboard nudge provider (lead only) ───────
  // User-only notices queue here and flush at agent_settled (post boundary).
  const pendingNotices = new NoticeBuffer();
  const monitor = createKanboardMonitor({
    list: () => listTasks(),
    listReady: () => listTasks(["--ready"]),
    session: sessionId,
    ownerStatus: () => getSharedOwnerStatus(),
    now: () => Date.now(),
    // User-only: only QUEUE here — a sendMessage custom message would be
    // converted to a user-role LLM message (never what a notice wants).
    // kanboard's agent_settled handler drains the buffer (appendEntry + toast).
    notify: (text, level) => {
      pendingNotices.queue(text, level);
    },
    // The monitor turned autowork off itself (done / stalled): the guard's
    // budget and the footer's `▣ autowork` flag must follow.
    onAutoworkOff: () => {
      guard.setAutowork(false);
      void refreshHolder();
    },
    cliPrefix: () => {
      const slug = projectSlug();
      return cli && slug ? `${cli.binary.path} --actor agent --project ${slug}` : null;
    },
    debug,
  });

  const refreshHolder = async (): Promise<void> => {
    try {
      setSharedKanboardStatus({
        claims: (await ownClaims()).map((task) => task.id),
        autowork: guard.remaining().autowork,
      });
    } catch {
      // The footer simply shows nothing until the next refresh.
    }
  };

  if (!isChildProcess()) {
    try {
      registerNudgeProvider("kanboard", 50, (info) => monitor.propose(info));
    } catch {
      // Registration must never block module load.
    }
    try {
      registerEvidenceContributor("kanboard", async () => ({
        blocking: (await ownClaims()).map(
          (task) => `${task.id} is still In Progress (claimed by this session) — finish it or move it to blocked`,
        ),
        notes: [],
      }));
    } catch {
      // Registration must never block module load.
    }
    registerBadgeRenderer(pi);
  }

  // ── command plumbing ─────────────────────────────────────────────────
  const buildDeps = (): CommandDeps => ({
      get cli() {
        return cli;
      },
      get unavailable() {
        return unavailable;
      },
      settings: () => readKanboardSettings(process.cwd()),
      revealSkill,
      setAutowork: (on) => {
        guard.setAutowork(on);
        monitor.setAutowork(on);
        if (on) monitor.arm("autowork");
        void refreshHolder();
      },
      guard,
      session: sessionId,
      debug,
      progress: (data) => appendProgress(pi, data),
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
    return true;
  };

  registerProgressRenderer(pi);
  registerKanboardCommands(pi, buildDeps());

  // R1 progress reminders for hand-worked tasks (silent in child sessions).
  registerProgressReminders(
    pi,
    createProgressTracker({
      enabled: () => readKanboardSettings().reminders,
      session: sessionId,
      list: () => listTasks(),
      cliPrefix: () => {
        const slug = projectSlug();
        return cli && slug ? `${cli.binary.path} --actor agent --project ${slug}` : null;
      },
      debug,
    }),
  );

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

  // ── run hooks: monitor, badges, holder (lead only) ───────────────────
  pi.on("before_agent_start", async (event) => {
    try {
      await monitor.onUserPrompt(String((event as { prompt?: unknown }).prompt ?? ""));
    } catch {
      // Prompt handling must never abort a turn.
    }
    return undefined;
  });
  pi.on("agent_start", () => {
    try {
      monitor.onAgentStart();
    } catch {
      // Accounting must never abort a turn.
    }
  });
  pi.on("agent_end", async (event) => {
    try {
      guard.onAgentEnd();
      monitor.onAgentEnd((event as { messages?: unknown[] }).messages);
    } catch {
      // Monitoring must never abort a turn.
    }
  });
  // Post-boundary: entries append fine here (they are dropped inside the
  // settle path), and the toast gives the notice a life outside the transcript.
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const ui = ctx as unknown as { hasUI?: boolean; ui?: { notify?: (t: string, l?: string) => void } } | undefined;
      flushNotices(
        pi,
        pendingNotices,
        {
          hasUI: ui?.hasUI,
          notify: (text, level) => ui?.ui?.notify?.(text, level ?? "info"),
        },
        debug,
      );
      void refreshHolder();
    } catch {
      // The footer simply shows nothing until the next refresh.
    }
  });
  pi.on("tool_result", async (event) => {
    const toolEvent = event as { toolName?: string; input?: Record<string, unknown>; isError?: boolean };
    try {
      if (isChildProcess()) return undefined;
      if (toolEvent.toolName !== "bash" && toolEvent.toolName !== "powershell") return undefined;
      maybeBadgeToolResult(pi, String(toolEvent.toolName), toolEvent.input, toolEvent.isError === true);
      if (toolEvent.isError) return undefined;
      const invocations = kanboardInvocations(String(toolEvent.input?.command ?? ""));
      if (invocations.some((inv) => inv.sub === "start" || inv.sub === "finish" || inv.sub === "move")) {
        if (invocations.some((inv) => inv.sub === "start")) monitor.arm("start");
        void refreshHolder();
      }
    } catch {
      // Badges and holder refreshes must never abort a turn.
    }
    return undefined;
  });

  // ── session lifecycle ────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Kanboard's own ambient children (summaries, --list-models) get this env:
    // they must not re-sync the runtime or spawn a daemon.
    if (process.env.UNIPI_KANBOARD_CHILD) return;
    // Children keep the session id they inherited from the lead.
    if (!isChildProcess()) {
      // Step 0: reason is "startup" even for -c/-r — never branch on it.
      process.env.UNIPI_KANBOARD_SESSION = `pi-${ctx.sessionManager.getSessionId()}`;
      process.env.UNIPI_KANBOARD_PID = String(process.pid);
    }
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
    // Reap claims whose pid died with the process (the runner used to do
    // this): released tasks get the "session lost: <session>" activity the
    // resume notice below keys on. The reaper acts as the system actor.
    if (!isChildProcess()) {
      try {
        const reaped = await cli!.run<unknown>(["reap", "--json"], {
          extraEnv: { UNIPI_KANBOARD_PROJECT: projectSlug(), UNIPI_KANBOARD_SESSION: sessionId() },
        });
        debug(`reap: ${JSON.stringify(reaped)}`);
      } catch (error) {
        debug(`reap failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    void refreshHolder();

    // Resume notice: claims the reaper released when a previous run of THIS
    // session died ("session lost: <session> …"), or that a shutdown released
    // ("released: … session ended mid-task (<session>)"). Once per start.
    // Activity entries are ordered oldest-first — the LAST one must be the
    // release (a task that moved on afterwards is not news).
    if (!isChildProcess()) {
      try {
        const session = sessionId();
        const stale = (await listTasks()).filter((task) => {
          if (task.status !== "todo") return false;
          const last = task.activity?.at(-1);
          if (!last) return false;
          return (
            last.text.startsWith(`session lost: ${session}`) ||
            last.text.includes(`released: session ended mid-task (${session})`)
          );
        });
        if (stale.length > 0) {
          const ids = stale.map((task) => task.id).join(", ");
          (ctx as unknown as { ui?: { notify?: (t: string, l?: string) => void } }).ui?.notify?.(
            `kanboard: ${ids} was released when the last run ended — ask me to re-start it`,
            "info",
          );
        }
      } catch (error) {
        debug(`resume notice failed: ${error instanceof Error ? error.message : String(error)}`);
      }
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
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Release this session's open claims so the board shows the truth. The
    // in_progress → todo transition allows the system actor only (the agent
    // cannot release), and release requires a comment — the next run's resume
    // notice keys on it. Best effort: a dead pid is reaped with "session
    // lost" anyway.
    // Children (subagents, fusion sidekicks, kanboard's own helpers) inherit
    // the lead's session id: their shutdown must never release the lead's
    // claims (a finished subagent used to bounce the lead's task to Todo).
    if (isChildProcess() || process.env.UNIPI_KANBOARD_CHILD) return;
    try {
      const session = sessionId();
      const claims = await ownClaims();
      const client = cli;
      const slug = projectSlug();
      if (!client || !slug || claims.length === 0) return;
      for (const task of claims) {
        await client
          .run([
            "--actor", "system",
            "--project", slug,
            "release", task.id, "--to", "todo",
            "--comment", `released: session ended mid-task (${session})`,
          ], {
            extraEnv: { UNIPI_KANBOARD_PROJECT: slug, UNIPI_KANBOARD_SESSION: session },
          })
          .then(() => debug(`released ${task.id} at shutdown`))
          .catch((error) => debug(`shutdown release ${task.id} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      setSharedKanboardStatus({ claims: [], autowork: guard.remaining().autowork });
    } catch {
      // Shutdown must never hang the session teardown.
    }
    void ctx;
  });
}
