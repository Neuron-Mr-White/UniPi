/**
 * @pi-unipi/kanboard — the runner (`/unipi:kanboard-autowork`).
 *
 * One job per session: claim the next ready task, let jev choose how to run it,
 * hand it to the agent, then write the lifecycle transition the agent is not
 * allowed to write. The runner owns claim → In Progress and run-end → In Review
 * (spec principle 2).
 */

import { appendProgress } from "@pi-unipi/core";
import { boardProgressData } from "./progress.js";
import { hostname as osHostname } from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { callCommandRunner, resolveDecisionModel, askJev, registerCompactionContext, UNIPI_EVENTS } from "@pi-unipi/core";

import { KanboardCliError, type KanboardCli } from "./bin.js";
import {
  asClaimResult,
  asTask,
  asTaskList,
  KanboardShapeError,
  type KanboardActivity,
  type KanboardRun,
  type KanboardClaim,
  type KanboardTask,
} from "./shapes.js";
import { applyLimitEnv, type KanboardSettings } from "./settings.js";

export const RUNNER_ENTRY = "unipi:kanboard-runner";

export type RunMode = "none" | "plan" | "goal" | "ralph" | "swarm" | "graph";

/** Work strategy = the long-horizon modes; `direct` maps to `none`. */
export type Strategy = "none" | "goal" | "ralph" | "swarm" | "graph";

export type { KanboardTask, KanboardActivity, KanboardRun };

interface RunnerState {
  phase: "idle" | "running" | "releasing";
  task: KanboardTask | null;
  mode: RunMode;
  goalId: string | null;
  /** Plan-first flag for the current task (requested by label or jev). */
  planning: boolean;
  /** Strategy held back until plan approval (set on planModeChanged). */
  pendingStrategy: Strategy | null;
  endsSinceSend: number;
  stopAfterCurrent: boolean;
  /** Autowork: keep claiming ready tasks after each finish (queue first). */
  autowork: boolean;
  settleTimer: NodeJS.Timeout | null;
  planOutcome: "approved" | "discarded" | null;
  /** Last assistant text seen on agent_end — the run summary source. */
  lastText: string;
  /** Text already consumed as a release summary (guards duplicate/late ends). */
  consumedText: string;
  /** When the current task's prompt was sent (ms). */
  sentAt: number;
  /** Last ctx seen — needed to apply a deferred strategy on plan approval. */
  lastCtx: ExtensionContext | undefined;
}

export interface RunnerDeps {
  pi: ExtensionAPI;
  cli: KanboardCli;
  /** Board project slug (kanboard settings `slug`, or the env override). */
  project: () => string;
  cwd: string;
  settings: () => KanboardSettings;
  debug: (line: string) => void;
}

export interface Runner {
  /** Autowork start: the loop pulls the session queue first, then claim-next. */
  work(ctx: ExtensionContext): Promise<void>;
  /** Drain this session's queue without touching the autowork flag. */
  drain(ctx: ExtensionContext): Promise<void>;
  stop(ctx: ExtensionContext): void;
  status(): { taskId: string | null; mode: RunMode | null; phase: string };
  onAgentEnd(event: { messages?: unknown[] }, ctx: ExtensionContext): void;
  onSessionStart(ctx: ExtensionContext): Promise<void>;
  onSessionShutdown(ctx: ExtensionContext): Promise<void>;
  onPlanModeChanged(payload: unknown): void;
}

/**
 * The askJev question the runner asks for mode choice, as a standalone export
 * so probes and tests exercise exactly what chooseStrategy sends.
 */
const STRATEGY_CRITERIA: Record<Strategy, string> = {
  none: "A well-scoped change one pass can finish and check.",
  goal: "One objective that needs iterating until it is verifiably done (tests, checks).",
  ralph: "An enumerable checklist of similar chores worked item by item.",
  swarm: "Several independent parts that can be worked in parallel, then combined.",
  graph: "Dependent steps where later work needs earlier results.",
};

type StrategyQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };

/**
 * The askJev questions the runner asks per claimed task — only for the fields
 * the task left unset (`strategy`/`plan` labels win; `auto` = jev decides).
 * Exported so probes and tests exercise exactly what chooseStrategy sends.
 */
export function strategyQuestion(task: KanboardTask): {
  state: string;
  questions: { strategy: StrategyQuestion };
} {
  return {
    state: `${task.title}\n\n${(task.body ?? "").slice(0, 2000)}`,
    questions: {
      strategy: {
        type: "choice",
        instructions: "Which work strategy should run this task?",
        criteria: { ...STRATEGY_CRITERIA },
      },
    },
  };
}

export function createRunner(deps: RunnerDeps): Runner {
  const { pi, cli, cwd } = deps;
  const project = (): string => deps.project();
  const state: RunnerState = {
    phase: "idle",
    task: null,
    mode: "none",
    goalId: null,
    planning: false,
    pendingStrategy: null,
    endsSinceSend: 0,
    stopAfterCurrent: false,
    autowork: false,
    settleTimer: null,
    planOutcome: null,
    lastText: "",
    consumedText: "",
    sentAt: 0,
    lastCtx: undefined,
  };

  const setStatus = (ctx: ExtensionContext, text?: string): void => {
    try {
      ctx.ui.setStatus("kanboard", text);
    } catch {
      // status is best-effort
    }
  };

  const describe = (): string =>
    state.task ? `▣ ${state.task.id} · ${state.mode}${state.planning ? " +plan" : ""}` : "▣ idle";

  const persist = (phase: string): void => {
    pi.appendEntry(RUNNER_ENTRY, {
      phase,
      taskId: state.task?.id ?? null,
      mode: state.mode,
      goalId: state.goalId,
      session: process.pid,
    });
  };

  // ── claiming ──────────────────────────────────────────────────────────────

  async function claimNext(): Promise<KanboardClaim> {
    const gate = deps.settings().chainGate;
    const raw = await runCli<unknown>(
      [
        "claim-next",
        "--session",
        sessionId(),
        "--pid",
        String(process.pid),
        "--host",
        hostname(),
        "--gate",
        gate,
      ],
      { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } },
    );
    return asClaimResult(raw);
  }

  async function claimById(id: string): Promise<KanboardClaim> {
    const gate = deps.settings().chainGate;
    const raw = await runCli<unknown>(
      ["claim-next", "--id", id, "--session", sessionId(), "--pid", String(process.pid), "--host", hostname(), "--gate", gate],
      { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } },
    );
    return asClaimResult(raw);
  }

  async function queueList(): Promise<string[]> {
    try {
      const raw = (await runCli<unknown>(["queue", "--list"], {
        extraEnv: { UNIPI_KANBOARD_PROJECT: project(), UNIPI_KANBOARD_SESSION: sessionId() },
      })) as { queue?: string[] };
      return Array.isArray(raw.queue) ? raw.queue : [];
    } catch (error) {
      deps.debug(`queue --list failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async function unqueue(id: string): Promise<void> {
    await cli
      .run(["unqueue", id], { extraEnv: { UNIPI_KANBOARD_PROJECT: project(), UNIPI_KANBOARD_SESSION: sessionId() } })
      .catch((error) => deps.debug(`unqueue ${id} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  function sessionId(): string {
    return process.env.UNIPI_KANBOARD_SESSION ?? `pi-${process.pid}`;
  }

  /** Every runner CLI call refreshes the env-carried limits first. */
  async function runCli<T>(argv: string[], options: Parameters<KanboardCli["run"]>[1] = {}): Promise<T> {
    applyLimitEnv(deps.settings());
    return cli.run<T>(argv, options);
  }

  function hostname(): string {
    // `process.env.HOSTNAME` is absent in some launches (tmux/systemd), and a
    // wrong host makes a stale run look like it belongs to another machine —
    // then nobody can release it. Ask the OS.
    const fromOs = (() => {
      try {
        return osHostname();
      } catch {
        return "";
      }
    })();
    return fromOs.trim() || process.env.HOSTNAME?.trim() || "unknown";
  }

  async function countWaiting(): Promise<{ waiting: number; blocked: number }> {
    try {
      const { tasks } = asTaskList(
        await runCli<unknown>(["list"], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
      );
      return {
        waiting: tasks.filter((task) => task.status === "todo").length,
        blocked: tasks.filter((task) => task.status === "blocked").length,
      };
    } catch {
      return { waiting: 0, blocked: 0 };
    }
  }

  // ── strategy choice (labels win; jev decides the unset) ───────────────────

  async function chooseStrategy(task: KanboardTask): Promise<{ strategy: Strategy; plan: boolean }> {
    // Labels win; the board defaults fill the gaps; jev only picks a strategy
    // when both leave it on auto. Plan is never a jev question.
    const board = deps.settings();
    const labelled = typeof task.strategy === "string" && (task.strategy as string) !== "auto" ? (task.strategy as Strategy) : undefined;
    const plan: boolean = typeof task.plan === "boolean" ? task.plan : board.defaultPlan === true;
    let strategy: Strategy | undefined = labelled;
    if (strategy === undefined && board.defaultStrategy !== "auto") {
      strategy = board.defaultStrategy as Strategy;
    }
    let jevAnswer: string | null = null;
    if (strategy === undefined) {
      const settings = resolveDecisionModel(cwd, "kanboard");
      const answers = await askJev({ ...strategyQuestion(task), settings, env: process.env });
      jevAnswer = answers?.strategy?.choice ?? null;
      strategy = jevAnswer !== null && jevAnswer in STRATEGY_CRITERIA ? (jevAnswer as Strategy) : "none";
    }
    deps.debug(`strategy ${task.id}: label=${labelled ?? "-"} board=${board.defaultStrategy}/${board.defaultPlan ? "plan" : "no-plan"} jev answered ${JSON.stringify(jevAnswer)} → ${strategy}${plan ? "+plan" : ""}`);
    return { strategy, plan };
  }

  // ── prompting ─────────────────────────────────────────────────────────────

  function renderPrompt(task: KanboardTask, all: KanboardTask[]): string {
    const binary = cli.binary.path;
    const activity = (task.activity ?? [])
      .slice(-10)
      .map((entry) => `- ${entry.at} [${entry.actor}] ${entry.text}`)
      .join("\n");
    const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
    const depLines = (task.deps ?? [])
      .map((id) => {
        const dep = byId.get(id);
        if (!dep) return `- ${id}: (missing)`;
        const note = (dep.activity ?? []).slice(-1)[0]?.text ?? "(no notes)";
        return `- ${id}: ${dep.title} — ${dep.status} · ${note}`;
      })
      .join("\n");

    return [
      `[kanboard ${task.id}] ${task.title}`,
      "",
      task.body?.trim() || "(no body)",
      "",
      "## Activity (latest 10)",
      activity || "(none)",
      "",
      "## Dependencies",
      depLines || "(none)",
      "",
      ...attachmentSection(task),
      "## Rules",
      `Work only on this task (${task.id}).`,
      `Use the board CLI through its absolute path and always pass the actor and project:`,
      `  ${binary} --actor agent --project ${project()} <command>`,
      ...(deps.settings().blocking === "ask"
        ? [
            `If you need information or a decision from the user, run:`,
            `  ${binary} --actor agent --project ${project()} move ${task.id} blocked --comment "<what you need>"`,
            "and stop — the runner will hand the task back when the user answers.",
          ]
        : [
            "Work autonomously. If something is unclear, make the most reasonable assumption, record it with",
            `  \`note ${task.id} "assumed: <what and why>"\`, and continue. Block only when you truly cannot continue —`,
            "missing credentials or access, a destructive or irreversible decision, or a contradiction in the",
            `  task — with \`${binary} --actor agent --project ${project()} move ${task.id} blocked --comment "<what you need>"\`, then stop.`,
          ]),
      `Do not move the task to in_review or done and do not cancel it: the runner writes those when your turn ends.`,
      `You may add notes with \`note ${task.id} "<text>"\`, link follow-up work with \`add\`, and reorder with \`order\`.`,
      `To show evidence (a screenshot, a log, a report), attach it: \`attach ${task.id} <file> --note "<what it shows>"\`.`,
    ].join("\n");
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  async function startTask(ctx: ExtensionContext): Promise<boolean> {
    state.lastCtx = ctx;
    let claimed: KanboardTask | null;
    let claim: KanboardClaim;
    try {
      claim = await claimNext();
      claimed = claim.task;
    } catch (error) {
      const message = error instanceof KanboardCliError ? error.message : String(error);
      ctx.ui.notify(`kanboard: ${message}`, "error");
      return false;
    }
    if (!claimed) {
      const counts = await countWaiting();
      ctx.ui.notify(nothingReadyMessage(counts, claim.waiting ?? []), "info");
      state.phase = "idle";
      setStatus(ctx, undefined);
      return false;
    }

    state.task = claimed;
    state.endsSinceSend = 0;
    state.planOutcome = null;
    state.planning = false;
    state.pendingStrategy = null;
    state.lastText = "";
    try {
      return await runClaimedTask(ctx, claimed);
    } catch (error) {
      // Anything thrown after the claim would otherwise leave the task
      // in_progress forever (K6 live bug: "all.map is not a function").
      const detail = error instanceof Error ? error.message : String(error);
      deps.debug(`task ${claimed.id} failed before the agent ran: ${detail}`);
      await releaseAfterFailure(ctx, claimed, detail);
      throw error;
    }
  }

  async function releaseAfterFailure(ctx: ExtensionContext, task: KanboardTask, detail: string): Promise<void> {
    state.phase = "releasing";
    try {
      const note = `runner error before handing the task over: ${detail}`.slice(0, 400);
      await runCli(["release", task.id, "--to", "todo", "--comment", note], {
        extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
      });
      ctx.ui.notify(`kanboard: ${task.id} released to Todo — ${note}`, "error");
    } catch (releaseError) {
      ctx.ui.notify(
        `kanboard: could not release ${task.id} after an error — ${
          releaseError instanceof Error ? releaseError.message : String(releaseError)
        }`,
        "error",
      );
    }
    state.task = null;
    state.goalId = null;
    state.phase = "idle";
    persist("idle");
    setStatus(ctx, undefined);
  }

  async function runClaimedTask(ctx: ExtensionContext, claimed: KanboardTask): Promise<boolean> {
    state.goalId = null;
    state.phase = "running";

    let strategy: Strategy = "none";
    let plan = false;
    try {
      ({ strategy, plan } = await chooseStrategy(claimed));
    } catch (error) {
      deps.debug(`strategy choice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // mode = the strategy that actually runs the work turn (plan rides alongside).
    state.mode = strategy;
    state.planning = plan;

    const all = await cli
      .run<unknown>(["list"], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } })
      .then((raw) => asTaskList(raw).tasks)
      .catch((error) => {
        deps.debug(`list failed while building the prompt: ${error instanceof Error ? error.message : String(error)}`);
        return [] as KanboardTask[];
      });

    if (plan) {
      const started = await callCommandRunner<{ ok?: boolean; reason?: string }>("unipi:plan-enter", ctx);
      if (!started.found || !started.result?.ok) {
        ctx.ui.notify(
          `kanboard: plan mode unavailable (${started.result?.reason ?? "workflow not loaded"}) — running without a plan`,
          "warning",
        );
        state.planning = false;
      }
    }
    if (state.planning) {
      // The strategy applies to the WORK turn after approval — apply it on
      // planModeChanged, not now (setExplicit would be consumed by the plan turn).
      state.pendingStrategy = strategy;
    } else {
      await applyStrategy(ctx, claimed, strategy);
    }

    persist("running");
    setStatus(ctx, describe());
    ctx.ui.notify(`▣ ${claimed.id} · ${state.mode}${state.planning ? " +plan" : ""} — ${claimed.title}`, "info");

    const prompt = renderPrompt(claimed, all);
    const busy = typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
    state.sentAt = Date.now();
    pi.sendUserMessage(prompt, busy ? { deliverAs: "followUp" } : undefined);
    return true;
  }

  /** Latest [parked goal: …] marker from the task's release comments, if any. */
  async function parkedGoalFromNotes(taskId: string): Promise<string | null> {
    try {
      const shown = asTask(
        "show",
        await runCli<unknown>(["show", taskId], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
      );
      const matches = (shown.activity ?? [])
        .map((entry) => entry.text.match(/\[parked goal: ([\w-]+)\]/)?.[1])
        .filter((goal): goal is string => typeof goal === "string");
      return matches.at(-1) ?? null;
    } catch {
      return null;
    }
  }

  /** Wire the chosen strategy for the work turn; falls back toward "none". */
  async function applyStrategy(ctx: ExtensionContext, task: KanboardTask, strategy: Strategy): Promise<void> {
    const setRun = (mode: RunMode, goal?: string): void => {
      void cli
        .run(
          ["set-run", task.id, "--mode", mode, ...(goal ? ["--goal", goal] : [])],
          { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } },
        )
        .catch((error) => deps.debug(`set-run failed: ${error instanceof Error ? error.message : String(error)}`));
    };
    const goalStart = async (): Promise<boolean> => {
      // A goal parked for THIS task (interrupted/released earlier) resumes
      // instead of starting fresh; a stale id falls through to goal-start.
      const priorGoal = task.run?.goal ?? (await parkedGoalFromNotes(task.id));
      if (priorGoal) {
        const resumed = await callCommandRunner<{ ok?: boolean; reason?: string }>(
          "unipi:goal-resume",
          ctx,
          { goalId: priorGoal },
        );
        if (resumed.found && resumed.result?.ok) {
          state.goalId = priorGoal;
          state.mode = "goal";
          setRun("goal", priorGoal);
          return true;
        }
      }
      const started = await callCommandRunner<{ ok?: boolean; goalId?: string; reason?: string }>(
        "unipi:goal-start",
        ctx,
        { objective: `${task.title} — ${(task.body ?? "").slice(0, 400)}`.trim() },
      );
      if (started.found && started.result?.ok && started.result.goalId) {
        state.goalId = started.result.goalId;
        state.mode = "goal";
        setRun("goal", state.goalId);
        return true;
      }
      return false;
    };
    switch (strategy) {
      case "none":
        state.mode = "none";
        setRun("none");
        return;
      case "goal":
        if (await goalStart()) return;
        ctx.ui.notify(`kanboard: goal unavailable — running without a strategy`, "warning");
        state.mode = "none";
        setRun("none");
        return;
      case "swarm":
      case "graph": {
        const started = await callCommandRunner<{ ok?: boolean; reason?: string }>(
          "unipi:lh-explicit",
          ctx,
          { mode: strategy },
        );
        if (started.found && started.result?.ok) {
          state.mode = strategy;
          setRun(strategy);
          return;
        }
        ctx.ui.notify(
          `kanboard: ${strategy} unavailable (${started.result?.reason ?? "long-horizon not loaded"}) — running without a strategy`,
          "warning",
        );
        state.mode = "none";
        setRun("none");
        return;
      }
      case "ralph": {
        const body = task.body ?? "";
        const started = await callCommandRunner<{ ok?: boolean; reason?: string }>(
          "unipi:ralph-start",
          ctx,
          { name: task.id, content: `${task.title}

${body}`.trim() },
        );
        if (started.found && started.result?.ok) {
          state.mode = "ralph";
          setRun("ralph");
          return;
        }
        ctx.ui.notify(
          `kanboard: ralph unavailable (${started.result?.reason ?? "no checklist items"}) — falling back to goal`,
          "warning",
        );
        if (await goalStart()) return;
        ctx.ui.notify(`kanboard: goal unavailable — running without a strategy`, "warning");
        state.mode = "none";
        setRun("none");
        return;
      }
    }
  }

  /** User-only board bar after each finished task. Best-effort. */
  async function postBoardProgress(): Promise<void> {
    try {
      const { tasks } = asTaskList(await runCli<unknown>(["list"], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }));
      const bar = boardProgressData(tasks, project());
      if (bar) appendProgress(pi, bar);
    } catch (error) {
      deps.debug(`board progress failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Ask the goal engine whether the goal reached a terminal state. */
  async function goalStatus(): Promise<{ status: string; reason?: string; objective?: string } | null> {
    const looked = await callCommandRunner<{ found?: boolean; status?: string; reason?: string; objective?: string }>(
      "unipi:goal-status",
      undefined,
      { goalId: state.goalId },
    );
    if (!looked.found || !looked.result?.found || !looked.result.status) return null;
    return { status: looked.result.status, reason: looked.result.reason, objective: looked.result.objective };
  }

  function planStillActive(): boolean {
    return state.planning && state.planOutcome === null;
  }

  async function finishTask(ctx: ExtensionContext, outcome: "in_review" | "todo" | "blocked", comment: string): Promise<void> {
    const task = state.task;
    if (!task) return;
    state.phase = "releasing";
    try {
      const value = asTask(
        "show",
        await runCli<unknown>(["show", task.id], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
      );
      // The user moved the task out from under the runner (done/cancelled/
      // backlog): stop its goal, leave the board alone.
      const movedAway = ["done", "cancelled", "backlog"].includes(value.status);
      if (movedAway && state.goalId) {
        await callCommandRunner("unipi:goal-stop", ctx, { goalId: state.goalId });
      }
      // A still-drivable goal is parked so re-claiming this task resumes it.
      // The id rides the release comment (activity survives; the run block
      // does not — release clears it).
      let parkedMarker = "";
      if (!movedAway && state.mode === "goal" && state.goalId) {
        const paused = await callCommandRunner<{ ok?: boolean; reason?: string }>(
          "unipi:goal-pause",
          ctx,
          { goalId: state.goalId },
        );
        if (paused.found && paused.result?.ok) {
          deps.debug(`goal ${state.goalId} parked for ${task.id}`);
          parkedMarker = ` [parked goal: ${state.goalId}]`;
        }
      }
      if (movedAway) {
        // The user's move stands — no release, just reset the runner.
        ctx.ui.notify(`▣ ${task.id} was moved to ${value.status} outside the runner — goal stopped`, "warning");
      } else if (value.status === "blocked") {
        const note = (value.activity ?? []).slice(-1)[0]?.text ?? "blocked";
        ctx.ui.notify(`▣ ${task.id} blocked: ${note}`, "warning");
      } else if (outcome === "in_review") {
        await runCli(["release", task.id, "--to", "in_review", "--comment", comment + parkedMarker], {
          extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
        });
        const first = comment.split("\n")[0]?.slice(0, 120) ?? "";
        ctx.ui.notify(`✓ ${task.id} → In Review: ${first}`, "info");
      } else {
        await runCli(["release", task.id, "--to", outcome, "--comment", comment + parkedMarker], {
          extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
        });
        ctx.ui.notify(`↩ ${task.id} → ${outcome === "todo" ? "Todo" : "Blocked"}: ${comment.slice(0, 120)}`, "warning");
      }
      if (movedAway) {
        state.consumedText = state.lastText.trim();
        state.task = null;
        state.goalId = null;
        state.endsSinceSend = 0;
        state.phase = "idle";
        persist("idle");
        setStatus(ctx, state.stopAfterCurrent ? undefined : describe());
        await postBoardProgress();
        await continueLoop(ctx);
        return;
      }
    } catch (error) {
      ctx.ui.notify(
        `kanboard: could not release ${task.id} — ${error instanceof KanboardCliError ? error.message : String(error)}`,
        "error",
      );
    }
    state.consumedText = state.lastText.trim();
    state.task = null;
    state.goalId = null;
    state.endsSinceSend = 0;
    state.phase = "idle";
    persist("idle");
    setStatus(ctx, state.stopAfterCurrent ? undefined : describe());
    await postBoardProgress();

    await continueLoop(ctx);
  }

  /**
   * After a task — or when -do closes with a non-empty queue: stop wins, then
   * the session queue (`claim-next --id`, skipping entries that went stale),
   * then autowork's `claim-next`. Nothing ready stops autowork.
   */
  async function continueLoop(ctx: ExtensionContext): Promise<void> {
    if (state.stopAfterCurrent) {
      state.stopAfterCurrent = false;
      state.autowork = false;
      state.phase = "idle";
      setStatus(ctx, undefined);
      ctx.ui.notify("kanboard: stopped", "info");
      return;
    }
    const queued = await queueList();
    if (queued.length > 0) {
      // Scan the queue in order: drop entries that can never run (gone, final,
      // no longer schedulable, or blocked by a cancelled dep), skip — but keep —
      // entries that merely wait on dependencies, and claim the first ready one.
      const { tasks } = asTaskList(
        await runCli<unknown>(["list"], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
      );
      const byId = new Map(tasks.map((task) => [task.id, task]));
      let waitingNote: string | null = null;
      let claimed: KanboardTask | null = null;
      for (const id of queued) {
        const task = byId.get(id);
        if (!task) {
          await unqueue(id);
          ctx.ui.notify(`kanboard: queued ${id} dropped — no longer on the board`, "warning");
          continue;
        }
        if (task.status !== "todo" && task.status !== "backlog") {
          await unqueue(id);
          ctx.ui.notify(`kanboard: queued ${id} dropped — now ${task.status}`, "warning");
          continue;
        }
        if (task.status !== "todo" || !task.ready) {
          const waitingFor = (task.waitingFor ?? []).join(", ");
          const cancelledDep = (task.waitingFor ?? []).find((dep) => byId.get(dep)?.status === "cancelled");
          if (cancelledDep) {
            await unqueue(id);
            ctx.ui.notify(`kanboard: queued ${id} dropped — waits on cancelled ${cancelledDep}`, "warning");
            continue;
          }
          waitingNote ??= task.status === "backlog"
            ? `${id} is still in Backlog (move it to Todo)`
            : waitingFor ? `${id} waits for ${waitingFor}` : `${id} is not ready`;
          continue;
        }
        await unqueue(id);
        let claim: KanboardClaim;
        try {
          claim = await claimById(id);
        } catch (error) {
          ctx.ui.notify(
            `kanboard: queued ${id} skipped — ${error instanceof KanboardCliError ? error.message : String(error)}`,
            "warning",
          );
          continue;
        }
        if (claim.task) {
          claimed = claim.task;
          break;
        }
      }
      if (claimed) {
        state.task = claimed;
        state.endsSinceSend = 0;
        state.planOutcome = null;
        state.lastText = "";
        try {
          await runClaimedTask(ctx, claimed);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          deps.debug(`queued task ${claimed.id} failed before the agent ran: ${detail}`);
          await releaseAfterFailure(ctx, claimed, detail);
        }
        return;
      }
      if (waitingNote) ctx.ui.notify(`kanboard: queue waiting: ${waitingNote}`, "info");
    }
    if (state.autowork) {
      const started = await startTask(ctx);
      if (!started) state.autowork = false;
      return;
    }
    state.phase = "idle";
    setStatus(ctx, undefined);
    if (queued.length === 0) ctx.ui.notify("kanboard: queue done", "info");
  }

  function lastAssistantText(messages: unknown[] | undefined): string {
    if (!Array.isArray(messages)) return "";
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { role?: string; content?: unknown };
      if (message?.role !== "assistant") continue;
      const content = message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: string }).text ?? "") : ""))
          .join("\n")
          .trim();
        if (text) return text;
      }
    }
    return "";
  }

  function isAbort(messages: unknown[] | undefined): boolean {
    if (!Array.isArray(messages)) return false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index] as { role?: string; stopReason?: string };
      if (message?.role === "assistant") return message.stopReason === "aborted";
    }
    return false;
  }

  // Compaction summaries lead with the task in flight, so the agent keeps its
  // task id and rules even when the original task prompt is summarized away.
  registerCompactionContext("kanboard", () =>
    state.phase === "running" && state.task
      ? kanboardCompactionBrief(state.task, state.mode, cli.binary.path, project(), deps.settings().blocking)
      : null,
  );

  return {
    async work(ctx: ExtensionContext): Promise<void> {
      if (state.phase !== "idle") {
        state.autowork = true;
        ctx.ui.notify("kanboard: a task is already running — autowork continues after it", "info");
        return;
      }
      state.autowork = true;
      state.stopAfterCurrent = false;
      await continueLoop(ctx);
    },

    async drain(ctx: ExtensionContext): Promise<void> {
      if (state.phase !== "idle") return;
      await continueLoop(ctx);
    },

    stop(ctx: ExtensionContext): void {
      if (state.phase === "idle") {
        ctx.ui.notify("kanboard: not running", "info");
        return;
      }
      state.stopAfterCurrent = true;
      ctx.ui.notify("kanboard: finishing the current task, then stopping", "info");
    },

    status() {
      return { taskId: state.task?.id ?? null, mode: state.task ? state.mode : null, phase: state.phase };
    },

    onAgentEnd(event: { messages?: unknown[] }, ctx: ExtensionContext): void {
      if (state.phase !== "running" || !state.task) return;
      if (isAbort(event.messages)) {
        if (state.settleTimer) clearTimeout(state.settleTimer);
        state.settleTimer = null;
        const task = state.task;
        state.stopAfterCurrent = true;
        void finishTask(ctx, "todo", "interrupted by user").then(() => {
          deps.debug(`aborted ${task.id} → todo`);
        });
        return;
      }
      // A late agent_end from the PREVIOUS task can arrive just after we claimed
      // the next one; settling on it would release the new task with the old
      // summary (seen live: PIT-3 released with PIT-2's text).
      const text = lastAssistantText(event.messages);
      if (text && text === state.consumedText) {
        deps.debug(`ignored late agent_end (same turn text as the previous release)`);
        return;
      }
      if (!text && Date.now() - state.sentAt < 150) {
        deps.debug("ignored agent_end right after sending the prompt");
        return;
      }
      state.endsSinceSend += 1;
      if (text) state.lastText = text;
      // A turnover can take several agent_end events (bg wakeups, extra turns):
      // settle only once nothing new arrives and the agent reports idle.
      if (state.settleTimer) clearTimeout(state.settleTimer);
      state.settleTimer = setTimeout(() => {
        state.settleTimer = null;
        void settle(ctx);
      }, 1200);
      state.settleTimer.unref?.();
    },

    onPlanModeChanged(payload: unknown): void {
      const active = (payload as { active?: boolean } | undefined)?.active;
      const reason = (payload as { reason?: string } | undefined)?.reason;
      if (active === false && state.planning && state.planOutcome === null) {
        state.planOutcome = reason === "discarded" ? "discarded" : "approved";
        deps.debug(`plan mode left: ${state.planOutcome}`);
        // Strategy applies to the work turn after approval.
        if (state.planOutcome === "approved" && state.pendingStrategy && state.task && state.lastCtx) {
          void applyStrategy(state.lastCtx, state.task, state.pendingStrategy);
        }
        state.pendingStrategy = null;
      }
    },

    async onSessionStart(ctx: ExtensionContext): Promise<void> {
      // Resume (or release) a task this session claimed before a reload.
      const entries: SessionEntry[] = ctx.sessionManager.getEntries();
      let claimed: { taskId?: string; mode?: RunMode; goalId?: string } | null = null;
      for (const entry of entries) {
        const custom = (entry as { customType?: string; data?: unknown }).customType;
        if (custom !== RUNNER_ENTRY) continue;
        const data = (entry as { data?: { phase?: string; taskId?: string; mode?: RunMode; goalId?: string } }).data;
        if (!data?.taskId) continue;
        claimed = data.phase === "idle" ? null : { taskId: data.taskId, mode: data.mode, goalId: data.goalId ?? undefined };
      }
      if (!claimed?.taskId) return;
      let task: KanboardTask;
      try {
        task = asTask(
          "show",
          await runCli<unknown>(["show", claimed.taskId], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
        );
      } catch {
        return;
      }
      if (task.status !== "in_progress") {
        persist("idle");
        return;
      }
      const resume = await ctx.ui.confirm(
        "Kanboard task in progress",
        `${task.id} "${task.title}" was claimed by this session — resume it (keep working), or release it to Todo?`,
      );
      if (resume) {
        state.task = task;
        // Old session entries may still say "direct" — it maps to "none".
        const restored = (claimed.mode as string | undefined) === "direct" ? "none" : (claimed.mode ?? "none");
        state.mode = restored;
        state.goalId = claimed.goalId ?? null;
        state.phase = "running";
        state.endsSinceSend = 0;
        setStatus(ctx, describe());
        pi.sendUserMessage(
          `[kanboard ${task.id}] Resuming "${task.title}" after a reload. Continue where you left off, following the same rules (block with a comment if you need the user; the runner releases the task when your turn ends).`,
        );
        return;
      }
      await runCli(["release", task.id, "--to", "todo", "--comment", "session ended"], {
        extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
      });
      persist("idle");
      ctx.ui.notify(`kanboard: ${task.id} released to Todo`, "info");
    },

    async onSessionShutdown(ctx: ExtensionContext): Promise<void> {
      if (!state.task || state.phase === "idle") return;
      try {
        await runCli(["release", state.task.id, "--to", "todo", "--comment", "session ended"], {
          extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
        });
      } catch (error) {
        deps.debug(`shutdown release failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      persist("idle");
      state.task = null;
      setStatus(ctx, undefined);
    },
  };

  async function settle(ctx: ExtensionContext): Promise<void> {
    if (state.phase !== "running" || !state.task) return;
    const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
    const pending = typeof ctx.hasPendingMessages === "function" ? ctx.hasPendingMessages() : false;
    if (!idle || pending) {
      // Something is still queued: wait for the next agent_end to re-arm.
      deps.debug("settle deferred: agent not idle");
      return;
    }

    if (planStillActive()) {
      deps.debug("settle deferred: plan mode still active");
      return;
    }
    if (state.planning && state.planOutcome === "discarded") {
      await finishTask(ctx, "todo", "plan discarded");
      return;
    }
    if (state.mode === "goal" && state.goalId) {
      const goal = await goalStatus();
      if (goal) {
        // A user-stopped goal is NOT success: the task goes back to Todo.
        if (goal.status === "complete" && goal.reason === "complete(user_requested)") {
          await finishTask(ctx, "todo", "goal stopped by user");
          return;
        }
        if (goal.status !== "complete") {
          if (["failed", "blocked", "stalled", "abandoned", "budget_exhausted"].includes(goal.status)) {
            await finishTask(ctx, "todo", `goal ${goal.status}`);
            return;
          }
          deps.debug(`settle deferred: goal ${goal.status}`);
          return;
        }
      }
    }

    const summary = state.lastText.trim() || lastAssistantText(collectMessages(ctx)) || "finished; see the activity log";
    const clipped = summary.length > 500 ? `${summary.slice(0, 499)}…` : summary;
    await finishTask(ctx, "in_review", clipped);
  }

  /** Best-effort read of the current transcript for the run summary. */
  function collectMessages(ctx: ExtensionContext): unknown[] {
    try {
      const branch: SessionEntry[] = ctx.sessionManager.getBranch();
      return branch
        .map((entry) => (entry as { message?: unknown }).message)
        .filter((message): message is object => typeof message === "object" && message !== null);
    } catch {
      return [];
    }
  }
}

export function createDebugLog(env: NodeJS.ProcessEnv = process.env): (line: string) => void {
  if (env.UNIPI_DEBUG_KANBOARD !== "1") return () => undefined;
  return (line: string) => {
    try {
      const { appendFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
      const { homedir } = require("node:os") as typeof import("node:os");
      const dir = `${homedir()}/.unipi/logs`;
      mkdirSync(dir, { recursive: true });
      appendFileSync(`${dir}/kanboard.log`, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // best-effort
    }
  };
}

/** Active-work text for compaction summaries (see core registerCompactionContext). */
export function kanboardCompactionBrief(
  task: KanboardTask,
  mode: string | null,
  binary: string,
  project: string,
  blocking: string,
): string {
  const body = (task.body ?? "").replace(/\s+/g, " ").trim();
  const cli = `${binary} --actor agent --project ${project}`;
  return [
    `Kanboard task ${task.id} "${task.title}" is in progress${mode && mode !== "none" ? ` (strategy: ${mode})` : ""} — work only on this task.`,
    body ? `Task: ${body.length > 600 ? `${body.slice(0, 599)}…` : body}` : "",
    `Board CLI: ${cli} <command>  (e.g. \`show ${task.id}\` for the full task, \`note ${task.id} "<text>"\`).`,
    blocking === "ask"
      ? `If you need the user: \`${cli} move ${task.id} blocked --comment "<what you need>"\`, then stop.`
      : `Work autonomously; block (\`move ${task.id} blocked --comment "…"\`) only when you truly cannot continue.`,
    "Do not move the task to in_review or done — the runner does that when your turn ends.",
  ].filter(Boolean).join("\n");
}

export function registerPlanEventListener(pi: ExtensionAPI, runner: Runner): void {
  pi.events.on(UNIPI_EVENTS.PLAN_MODE_CHANGED, (payload: unknown) => runner.onPlanModeChanged(payload));
}

/**
 * "Nothing ready" with the reason spelled out: tasks locked behind a Backlog
 * dependency need a human to schedule that dependency — the runner never claims
 * Backlog — so name them instead of leaving a bare count.
 */
export function nothingReadyMessage(
  counts: { waiting: number; blocked: number },
  waiting: Array<{ id: string; waitingFor?: string[]; lockedBy?: string[] }>,
): string {
  const head = `Nothing ready (${counts.waiting} waiting on deps, ${counts.blocked} blocked)`;
  const locked = waiting.filter((entry) => (entry.lockedBy ?? []).length > 0);
  if (locked.length === 0) return head;
  const lines = locked
    .slice(0, 5)
    .map((entry) => `  ${entry.id} waits on ${entry.lockedBy!.join(", ")}, still in Backlog — move it to Todo to unlock`);
  if (locked.length > 5) lines.push(`  …and ${locked.length - 5} more`);
  return [head, ...lines].join("\n");
}

/**
 * Attachments the user added (screenshots, logs, documents). `att:` references in
 * the body/activity point at these; the agent reads them straight from disk.
 */
export function attachmentSection(task: KanboardTask): string[] {
  const items = Array.isArray(task.attachments) ? (task.attachments as Array<{ ref?: string; path?: string; kind?: string; original?: string; size?: number }>) : [];
  if (items.length === 0) return [];
  return [
    "## Attachments",
    "References like `att:ID/name` in the text above are these files — read them from disk (images with your image-reading tool):",
    ...items.map((item) => `- ${item.ref ?? "?"} → ${item.path ?? "?"} (${item.kind ?? "file"}, ${item.size ?? 0} bytes)`),
    "",
  ];
}
