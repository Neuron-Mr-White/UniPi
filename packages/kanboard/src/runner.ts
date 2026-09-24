/**
 * @pi-unipi/kanboard — the runner (`/unipi:kanboard work`).
 *
 * One job per session: claim the next ready task, let jev choose how to run it,
 * hand it to the agent, then write the lifecycle transition the agent is not
 * allowed to write. The runner owns claim → In Progress and run-end → In Review
 * (spec principle 2).
 */

import { hostname as osHostname } from "node:os";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { callCommandRunner, readJudgeJevSettings, askJev, UNIPI_EVENTS } from "@pi-unipi/core";

import { KanboardCliError, type KanboardCli } from "./bin.js";
import {
  asClaimResult,
  asTask,
  asTaskList,
  KanboardShapeError,
  type KanboardActivity,
  type KanboardRun,
  type KanboardTask,
} from "./shapes.js";
import type { KanboardSettings } from "./settings.js";

export const RUNNER_ENTRY = "unipi:kanboard-runner";

export type RunMode = "direct" | "plan" | "goal";

export type { KanboardTask, KanboardActivity, KanboardRun };

interface RunnerState {
  phase: "idle" | "running" | "releasing";
  task: KanboardTask | null;
  mode: RunMode;
  goalId: string | null;
  endsSinceSend: number;
  stopAfterCurrent: boolean;
  settleTimer: NodeJS.Timeout | null;
  planOutcome: "approved" | "discarded" | null;
  /** Last assistant text seen on agent_end — the run summary source. */
  lastText: string;
  /** Text already consumed as a release summary (guards duplicate/late ends). */
  consumedText: string;
  /** When the current task's prompt was sent (ms). */
  sentAt: number;
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
  work(ctx: ExtensionContext): Promise<void>;
  stop(ctx: ExtensionContext): void;
  status(): { taskId: string | null; mode: RunMode | null; phase: string };
  onAgentEnd(event: { messages?: unknown[] }, ctx: ExtensionContext): void;
  onSessionStart(ctx: ExtensionContext): Promise<void>;
  onSessionShutdown(ctx: ExtensionContext): Promise<void>;
  onPlanModeChanged(payload: unknown): void;
}

export function createRunner(deps: RunnerDeps): Runner {
  const { pi, cli, cwd } = deps;
  const project = (): string => deps.project();
  const state: RunnerState = {
    phase: "idle",
    task: null,
    mode: "direct",
    goalId: null,
    endsSinceSend: 0,
    stopAfterCurrent: false,
    settleTimer: null,
    planOutcome: null,
    lastText: "",
    consumedText: "",
    sentAt: 0,
  };

  const setStatus = (ctx: ExtensionContext, text?: string): void => {
    try {
      ctx.ui.setStatus("kanboard", text);
    } catch {
      // status is best-effort
    }
  };

  const describe = (): string => (state.task ? `▣ ${state.task.id} · ${state.mode}` : "▣ idle");

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

  async function claimNext(): Promise<KanboardTask | null> {
    const gate = deps.settings().chainGate;
    const raw = await cli.run<unknown>(
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
    return asClaimResult(raw).task;
  }

  function sessionId(): string {
    return process.env.UNIPI_KANBOARD_SESSION ?? `pi-${process.pid}`;
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
        await cli.run<unknown>(["list"], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
      );
      return {
        waiting: tasks.filter((task) => task.status === "todo").length,
        blocked: tasks.filter((task) => task.status === "blocked").length,
      };
    } catch {
      return { waiting: 0, blocked: 0 };
    }
  }

  // ── mode choice (jev) ─────────────────────────────────────────────────────

  async function chooseMode(task: KanboardTask): Promise<RunMode> {
    const settings = readJudgeJevSettings(cwd);
    const state_text = `${task.title}\n\n${(task.body ?? "").slice(0, 2000)}`;
    const answers = await askJev({
      state: state_text,
      questions: {
        mode: {
          type: "choice",
          instructions: "How should this task be executed?",
          criteria: {
            direct: "A small, clear change — just do it",
            plan: "Multi-file or design choices; needs a plan approved first",
            goal: "A large multi-step objective that needs many turns and verification",
          },
        },
      },
      settings,
      env: process.env,
    });
    const choice = answers?.mode?.choice;
    const mode: RunMode = choice === "plan" || choice === "goal" ? choice : "direct";
    deps.debug(`mode ${task.id}: jev answered ${JSON.stringify(choice ?? null)} → ${mode}`);
    return mode;
  }

  // ── prompting ─────────────────────────────────────────────────────────────

  function renderPrompt(task: KanboardTask, all: KanboardTask[]): string {
    const binary = cli.binary.path;
    const activity = (task.activity ?? [])
      .slice(-10)
      .map((entry) => `- ${entry.at} [${entry.actor}] ${entry.text}`)
      .join("\n");
    const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
    const deps = (task.deps ?? [])
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
      deps || "(none)",
      "",
      "## Rules",
      `Work only on this task (${task.id}).`,
      `Use the board CLI through its absolute path and always pass the actor and project:`,
      `  ${binary} --actor agent --project ${project()} <command>`,
      `If you need information or a decision from the user, run:`,
      `  ${binary} --actor agent --project ${project()} move ${task.id} blocked --comment "<what you need>"`,
      "and stop — the runner will hand the task back when the user answers.",
      `Do not move the task to in_review or done and do not cancel it: the runner writes those when your turn ends.`,
      `You may add notes with \`note ${task.id} "<text>"\`, link follow-up work with \`add\`, and reorder with \`order\`.`,
    ].join("\n");
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  async function startTask(ctx: ExtensionContext): Promise<boolean> {
    let claimed: KanboardTask | null;
    try {
      claimed = await claimNext();
    } catch (error) {
      const message = error instanceof KanboardCliError ? error.message : String(error);
      ctx.ui.notify(`kanboard: ${message}`, "error");
      return false;
    }
    if (!claimed) {
      const counts = await countWaiting();
      ctx.ui.notify(
        `Nothing ready (${counts.waiting} waiting on deps, ${counts.blocked} blocked)`,
        "info",
      );
      state.phase = "idle";
      setStatus(ctx, undefined);
      return false;
    }

    state.task = claimed;
    state.endsSinceSend = 0;
    state.planOutcome = null;
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
      await cli.run(["release", task.id, "--to", "todo", "--comment", note], {
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

    let mode: RunMode = "direct";
    try {
      mode = await chooseMode(claimed);
    } catch (error) {
      deps.debug(`mode choice failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    state.mode = mode;

    const all = await cli
      .run<unknown>(["list"], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } })
      .then((raw) => asTaskList(raw).tasks)
      .catch((error) => {
        deps.debug(`list failed while building the prompt: ${error instanceof Error ? error.message : String(error)}`);
        return [] as KanboardTask[];
      });

    // Record the mode (and the goal id once it exists) on the task itself.
    await cli
      .run(["set-run", claimed.id, "--mode", mode], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } })
      .catch((error) => deps.debug(`set-run failed: ${error instanceof Error ? error.message : String(error)}`));

    if (mode === "plan") {
      const started = await callCommandRunner<{ ok?: boolean; reason?: string }>("unipi:plan-enter", ctx);
      if (!started.found || !started.result?.ok) {
        ctx.ui.notify(
          `kanboard: plan mode unavailable (${started.result?.reason ?? "workflow not loaded"}) — running direct`,
          "warning",
        );
        state.mode = "direct";
      }
    }
    if (state.mode === "goal") {
      const started = await callCommandRunner<{ ok?: boolean; goalId?: string; reason?: string }>(
        "unipi:goal-start",
        ctx,
        { objective: `${claimed.title} — ${(claimed.body ?? "").slice(0, 400)}`.trim() },
      );
      if (started.found && started.result?.ok && started.result.goalId) {
        state.goalId = started.result.goalId;
        await cli
          .run(["set-run", claimed.id, "--mode", "goal", "--goal", state.goalId], {
            extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
          })
          .catch(() => undefined);
      } else {
        ctx.ui.notify(
          `kanboard: goal mode unavailable (${started.result?.reason ?? "long-horizon not loaded"}) — running direct`,
          "warning",
        );
        state.mode = "direct";
      }
    }

    persist("running");
    setStatus(ctx, describe());
    ctx.ui.notify(`▣ ${claimed.id} · ${state.mode} — ${claimed.title}`, "info");

    const prompt = renderPrompt(claimed, all);
    const busy = typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
    state.sentAt = Date.now();
    pi.sendUserMessage(prompt, busy ? { deliverAs: "followUp" } : undefined);
    return true;
  }

  /** Ask the goal engine whether the goal reached a terminal state. */
  async function goalStatus(): Promise<{ status: string; objective?: string } | null> {
    const looked = await callCommandRunner<{ found?: boolean; status?: string; objective?: string }>(
      "unipi:goal-status",
      undefined,
      { goalId: state.goalId },
    );
    if (!looked.found || !looked.result?.found || !looked.result.status) return null;
    return { status: looked.result.status, objective: looked.result.objective };
  }

  function planStillActive(): boolean {
    return state.mode === "plan" && state.planOutcome === null;
  }

  async function finishTask(ctx: ExtensionContext, outcome: "in_review" | "todo" | "blocked", comment: string): Promise<void> {
    const task = state.task;
    if (!task) return;
    state.phase = "releasing";
    try {
      const value = asTask(
        "show",
        await cli.run<unknown>(["show", task.id], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
      );
      if (value.status === "blocked") {
        const note = (value.activity ?? []).slice(-1)[0]?.text ?? "blocked";
        ctx.ui.notify(`▣ ${task.id} blocked: ${note}`, "warning");
      } else if (outcome === "in_review") {
        await cli.run(["release", task.id, "--to", "in_review", "--comment", comment], {
          extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
        });
        const first = comment.split("\n")[0]?.slice(0, 120) ?? "";
        ctx.ui.notify(`✓ ${task.id} → In Review: ${first}`, "info");
      } else {
        await cli.run(["release", task.id, "--to", outcome, "--comment", comment], {
          extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
        });
        ctx.ui.notify(`↩ ${task.id} → ${outcome === "todo" ? "Todo" : "Blocked"}: ${comment.slice(0, 120)}`, "warning");
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

    if (state.stopAfterCurrent) {
      state.stopAfterCurrent = false;
      ctx.ui.notify("kanboard: stopped", "info");
      return;
    }
    if (deps.settings().continue) {
      await startTask(ctx);
    } else {
      setStatus(ctx, undefined);
      ctx.ui.notify("kanboard: queue done (continue is off)", "info");
    }
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

  return {
    async work(ctx: ExtensionContext): Promise<void> {
      if (state.phase !== "idle") {
        ctx.ui.notify("kanboard: a task is already running", "warning");
        return;
      }
      state.stopAfterCurrent = false;
      await startTask(ctx);
    },

    stop(ctx: ExtensionContext): void {
      if (state.phase === "idle") {
        ctx.ui.notify("kanboard: nothing to stop", "info");
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
      if (active === false && state.mode === "plan") {
        state.planOutcome = reason === "discarded" ? "discarded" : "approved";
        deps.debug(`plan mode left: ${state.planOutcome}`);
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
          await cli.run<unknown>(["show", claimed.taskId], { extraEnv: { UNIPI_KANBOARD_PROJECT: project() } }),
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
        state.mode = claimed.mode ?? "direct";
        state.goalId = claimed.goalId ?? null;
        state.phase = "running";
        state.endsSinceSend = 0;
        setStatus(ctx, describe());
        pi.sendUserMessage(
          `[kanboard ${task.id}] Resuming "${task.title}" after a reload. Continue where you left off, following the same rules (block with a comment if you need the user; the runner releases the task when your turn ends).`,
        );
        return;
      }
      await cli.run(["release", task.id, "--to", "todo", "--comment", "session ended"], {
        extraEnv: { UNIPI_KANBOARD_PROJECT: project() },
      });
      persist("idle");
      ctx.ui.notify(`kanboard: ${task.id} released to Todo`, "info");
    },

    async onSessionShutdown(ctx: ExtensionContext): Promise<void> {
      if (!state.task || state.phase === "idle") return;
      try {
        await cli.run(["release", state.task.id, "--to", "todo", "--comment", "session ended"], {
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
    if (state.mode === "plan" && state.planOutcome === "discarded") {
      await finishTask(ctx, "todo", "plan discarded");
      return;
    }
    if (state.mode === "goal" && state.goalId) {
      const goal = await goalStatus();
      if (goal && goal.status !== "complete") {
        if (["failed", "blocked", "stalled", "abandoned", "budget_exhausted"].includes(goal.status)) {
          await finishTask(ctx, "todo", `goal ${goal.status}`);
          return;
        }
        deps.debug(`settle deferred: goal ${goal.status}`);
        return;
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

export function registerPlanEventListener(pi: ExtensionAPI, runner: Runner): void {
  pi.events.on(UNIPI_EVENTS.PLAN_MODE_CHANGED, (payload: unknown) => runner.onPlanModeChanged(payload));
}
