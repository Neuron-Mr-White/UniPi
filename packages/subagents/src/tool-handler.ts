/**
 * @pi-unipi/subagents — spawn_helper parity handler
 *
 * Routes the extended spawn_helper surface: management actions, workflowScript
 * execution, and legacy single-child launches (type/prompt aliases). Applies
 * the Phase 2 libraries: agent resolution + aliases, enablement, budgets,
 * depth guard, context policy, spawn budgets, timeout defaults, and output
 * truncation. The render/notify plumbing stays in index.ts — this module only
 * decides and executes.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import type { SubagentsConfig, AgentConfig } from "./types.js";
import { SUBAGENT_ACTIONS } from "./parity-types.js";
import { runWorkflowScript, type WorkflowScriptChildResult } from "./workflow-script.js";
import {
  resolveTurnBudgetConfig,
  validateToolBudgetConfig,
  validateUsageBudgetConfig,
  appendTurnBudgetSystemPrompt,
} from "./budgets.js";
import {
  createRunFanoutBudget,
  claimRunFanoutBatch,
  getRunFanoutBudgetSnapshot,
  formatRunFanoutBudget,
} from "./run-fanout-budget.js";
import { truncateOutput, resolveMaxOutput } from "./output-limits.js";
import {
  resolveContext,
  assertForegroundContextSupported,
  resolveMaxSubagentDepth,
  depthExceeded,
  isFanoutChild,
  withChildBoundaryInstructions,
} from "./child-safety.js";
import { listRetainedChildren, formatRetainedChildren, resolveResumeTarget } from "./retained-children.js";
import { ASYNC_DIR, TEMP_ROOT_DIR, RESULTS_DIR } from "./parity-types.js";
import { buildGuideText } from "./guide.js";
import { ScheduledRunManager } from "./scheduled-runs.js";
import {
  resolveMissionStoreLocation,
  createMission,
  readMission,
  listMissions,
  updateMission,
  MissionNotFoundError,
  type MissionStoreConfig,
  type MissionStatus,
} from "./mission-store.js";

export interface HandlerDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  config: SubagentsConfig;
  /** Legacy single-child spawn (foreground). */
  spawnForeground: (
    ctx: ExtensionContext,
    agentName: string,
    prompt: string,
    options: {
      description?: string;
      maxTurns?: number;
      modelInput?: string;
      thinkingLevel?: unknown;
      signal?: AbortSignal;
    },
  ) => Promise<{ ok: boolean; output: string; error?: string; toolUses: number; durationMs: number }>;
  /** Legacy single-child spawn (background). */
  spawnBackground: (
    ctx: ExtensionContext,
    agentName: string,
    prompt: string,
    options: {
      description?: string;
      maxTurns?: number;
      modelInput?: string;
      thinkingLevel?: unknown;
    },
  ) => string;
  /** Session-wide cumulative spawn accounting (maxSubagentSpawnsPerSession). */
  spawnAccounting?: {
    used(): number;
    cap(): number | undefined;
    consume(count: number): void;
  };
  /** Depth env for the recursion guard. */
  env?: NodeJS.ProcessEnv;
  /** Retained-children dir override (defaults to our async temp root). */
  retainedDir?: string;
  /** Mission store config (from OUR subagents.json). */
  missionConfig?: MissionStoreConfig;
  /** Project root for mission records. */
  projectRoot?: string;
  /** Async process runner (Phase 3). When present, background launches and
   *  fork contexts run as child pi processes; when absent they error with
   *  guidance (test environments). */
  runAsync?: (launch: {
    agentName: string;
    task: string;
    description?: string;
    model?: string;
    thinking?: string | false;
    context: "fresh" | "fork";
    timeoutMs?: number;
    maxTurns?: number;
    /** Resume: continue a retained child in its stored session. */
    resumeSessionFile?: string;
    /** Worktree isolation: launch the child in a managed git worktree. */
    worktree?: boolean;
  }) => Promise<{
    runId: string;
    status: string;
    output?: string;
    error?: string;
  }>;
}

function textResult(msg: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: msg }], details };
}

/** Parse + validate everything, resolve the agent, or return an error result. */
function preflight(
  deps: HandlerDeps,
  args: Record<string, unknown>,
): { ok: true; agent: AgentConfig; agentName: string; prompt: string } | { ok: false; error: string } {
  const agentNameRaw = (args.agent ?? args.type) as string | undefined;
  const prompt = (args.task ?? args.prompt) as string | undefined;

  if (!agentNameRaw || typeof agentNameRaw !== "string") {
    return { ok: false, error: "spawn_helper requires an agent (or legacy type) parameter." };
  }

  const agentName = deps.manager.resolveAlias(agentNameRaw);
  const agent = deps.manager.getAgentConfig(agentName);
  if (!agent) {
    const known = deps.manager.getKnownTypes().join(", ");
    return { ok: false, error: `Unknown agent type "${agentNameRaw}". Known types: ${known}` };
  }
  if (!deps.manager.isTypeEnabled(agentName)) {
    return { ok: false, error: `Agent type "${agentName}" is disabled by configuration.` };
  }

  // Depth guard
  const env = deps.env ?? process.env;
  const maxDepth = resolveMaxSubagentDepth(agent, deps.config, env);
  if (depthExceeded(env, maxDepth)) {
    return {
      ok: false,
      error: `Subagent depth cap reached (maxSubagentDepth ${maxDepth}). This child cannot spawn further subagents for its assigned fanout.`,
    };
  }

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return { ok: false, error: "spawn_helper requires a task (or legacy prompt) parameter." };
  }

  return { ok: true, agent, agentName, prompt };
}

/**
 * Main entry: route a spawn_helper invocation.
 * Returns a tool result; never throws.
 */
export async function handleSpawnHelper(
  deps: HandlerDeps,
  ctx: ExtensionContext,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
  try {
    // ---- Management actions ----
    const action = args.action as string | undefined;
    if (action !== undefined) {
      return await handleAction(deps, ctx, action, args);
    }

    // ---- workflowScript execution ----
    const workflowScript = args.workflowScript as string | undefined;
    if (workflowScript !== undefined) {
      return await handleWorkflowScript(deps, ctx, workflowScript, args, signal);
    }

    // ---- Single-child launch (legacy + reference params) ----
    return await handleSingleChild(deps, ctx, args, signal);
  } catch (error) {
    return textResult(
      `spawn_helper failed: ${error instanceof Error ? error.message : String(error)}`,
      { status: "error", error: error instanceof Error ? error.message : String(error) },
    );
  }
}

// ============================================================================
// Management actions
// ============================================================================

async function handleAction(
  deps: HandlerDeps,
  _ctx: ExtensionContext,
  action: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
  if (!(SUBAGENT_ACTIONS as readonly string[]).includes(action)) {
    return textResult(
      `Unknown action "${action}". Supported actions: ${SUBAGENT_ACTIONS.join(", ")}.`,
      { status: "error" },
    );
  }

  switch (action) {
    case "list": {
      const types = deps.manager.getKnownTypes();
      const lines = types.map((type) => {
        const agent = deps.manager.getAgentConfig(type);
        const enabled = deps.manager.isTypeEnabled(type);
        const scope = agent?.source ?? "config";
        const desc = agent?.description ?? "";
        return `- ${type}${agent?.aliases?.length ? ` (aliases: ${agent.aliases.join(", ")})` : ""} [${scope}]${enabled ? "" : " [disabled]"}: ${desc}`;
      });
      return textResult(`Available subagents:\n${lines.join("\n")}`);
    }

    case "get": {
      const target = (args.agent ?? args.type ?? args.id) as string | undefined;
      if (!target) return textResult("action 'get' requires an agent name.");
      const agentName = deps.manager.resolveAlias(target);
      const agent = deps.manager.getAgentConfig(agentName);
      if (!agent) return textResult(`Unknown agent "${target}".`);
      return textResult(
        [
          `Agent: ${agent.name}`,
          ...(agent.aliases?.length ? [`Aliases: ${agent.aliases.join(", ")}`] : []),
          `Description: ${agent.description}`,
          `Source: ${agent.source ?? "builtin"}`,
          `Tools: ${agent.builtinToolNames?.join(", ") || "(all builtins)"}`,
          ...(agent.disallowedTools?.length ? [`Disallowed: ${agent.disallowedTools.join(", ")}`] : []),
          `Prompt mode: ${agent.promptMode}`,
          ...(agent.model ? [`Model: ${agent.model}`] : []),
          ...(agent.thinking !== undefined ? [`Thinking: ${String(agent.thinking)}`] : []),
          ...(agent.defaultContext ? [`Default context: ${agent.defaultContext}`] : []),
          ...(agent.timeoutMs ? [`Timeout: ${agent.timeoutMs}ms`] : []),
          `Enabled: ${deps.manager.isTypeEnabled(agentName)}`,
        ].join("\n"),
      );
    }

    case "status": {
      const accounting = deps.spawnAccounting;
      const sessionCap = accounting?.cap();
      const used = accounting?.used() ?? 0;
      const lines = [
        `Active agents: ${deps.manager.listAgents().filter((a) => a.status === "running" || a.status === "queued").length}`,
        `Max concurrent: ${deps.manager.getMaxConcurrent()}`,
      ];
      if (sessionCap !== undefined) {
        lines.push(
          `Session spawn budget: ${used}/${sessionCap} used, ${Math.max(0, sessionCap - used)} remaining`,
        );
      } else {
        lines.push("Session spawn budget: unlimited");
      }
      const running = deps.manager.listAgents().filter((a) => a.status === "running" || a.status === "queued");
      for (const record of running) {
        lines.push(`- ${record.id} [${record.type}] ${record.status}: ${record.description}`);
      }
      return textResult(lines.join("\n"));
    }

    case "children.list": {
      const retained = listRetainedChildren(deps.retainedDir ?? ASYNC_DIR);
      if (retained.length === 0) {
        // Fall back to in-process completed agents from this session.
        const recent = deps.manager
          .listAgents()
          .filter((a) => a.status !== "running" && a.status !== "queued")
          .slice(-10);
        if (recent.length === 0) return textResult("No completed children in this session yet.");
        return textResult(
          recent.map((r) => `- ${r.id} [${r.type}] ${r.status}: ${r.description}`).join("\n"),
        );
      }
      return textResult(formatRetainedChildren(retained));
    }

    case "resume": {
      const id = args.id as string | undefined;
      const message = args.message as string | undefined;
      if (!id) return textResult("action 'resume' requires an id (retained run id or prefix).");
      if (!message || !message.trim()) return textResult("action 'resume' requires a non-empty follow-up message.");
      if (!deps.runAsync) {
        return textResult("action 'resume' requires the background process runner, which is unavailable in this host.", { status: "error" });
      }
      const target = resolveResumeTarget(deps.retainedDir ?? ASYNC_DIR, id);
      if (!target.ok) return textResult(target.error, { status: "error" });
      const result = await deps.runAsync({
        agentName: target.agent,
        task: message.trim(),
        description: `resume ${target.runId.slice(-8)}`,
        context: "fresh",
        resumeSessionFile: target.sessionFile,
      });
      return textResult(
        `Resumed ${target.runId} as ${result.runId} (agent: ${target.agent}, stored session contract kept).\nUse get_helper_result to retrieve results.`,
        { status: "background", runId: result.runId },
      );
    }

    case "stop": {
      const id = args.id as string | undefined;
      if (!id) return textResult("action 'stop' requires an id.");
      const record = deps.manager.getRecord(id);
      if (!record) return textResult(`Run not found: "${id}".`);
      record.abortController?.abort();
      return textResult(`Stop requested for ${id} (${record.type}, ${record.status}).`);
    }

    case "grant-spawn-budget": {
      const accounting = deps.spawnAccounting;
      if (!accounting) return textResult("Spawn budget accounting is unavailable in this host.");
      const cap = accounting.cap();
      if (cap === undefined) return textResult("Session spawn budget is unlimited; nothing to grant.");
      const additional = args.additional as number | undefined;
      if (typeof additional !== "number" || !Number.isInteger(additional) || additional < 1) {
        return textResult("action 'grant-spawn-budget' requires a positive integer 'additional'.");
      }
      // Grants require interactive confirmation — delegated to the host via pi.
      return textResult(
        `grant-spawn-budget requires native user confirmation; requested +${additional} against cap ${cap}. ` +
          `This action needs the interactive parent; run it from the root session.`,
      );
    }

    case "doctor": {
      const lines: string[] = [
        "Subagents doctor report",
        "",
        "Runtime",
        `- cwd: ${process.cwd()}`,
        `- async runner: ${deps.runAsync ? "available (child pi processes)" : "unavailable"}`,
        "",
        "Filesystem",
        `- temp root: ${TEMP_ROOT_DIR}${existsSync(TEMP_ROOT_DIR) ? "" : " (created on first run)"}`,
        `- async runs: ${ASYNC_DIR}`,
        `- results: ${RESULTS_DIR}`,
        "",
        "Discovery",
        `- known agent types: ${deps.manager.getKnownTypes().length}`,
        ...deps.manager.getKnownTypes().map((type) => {
          const agent = deps.manager.getAgentConfig(type);
          const enabled = deps.manager.isTypeEnabled(type);
          return `  - ${type} [${agent?.source ?? "config"}]${enabled ? "" : " [disabled]"}${agent?.aliases?.length ? ` (aliases: ${agent.aliases.join(", ")})` : ""}`;
        }),
        "",
        "Budgets",
        `- run timeout default: ${deps.config.timeoutMs ?? "30min (default)"}`,
        `- tool timeout: ${deps.config.toolTimeoutMs ?? "env/known-fast defaults"}`,
        `- spawn caps: run=${deps.config.maxSubagentSpawnsPerRun ?? 64}, session=${deps.config.maxSubagentSpawnsPerSession ?? "unlimited"}, active-async=${deps.config.maxActiveAsyncRunsPerSession ?? "unlimited"}`,
        `- depth cap: ${resolveMaxSubagentDepth(undefined, deps.config, deps.env ?? process.env)}`,
        "",
        "Concurrency",
        `- maxConcurrent: ${deps.config.maxConcurrent}`,
        `- active in-process: ${deps.manager.listAgents().filter((a) => a.status === "running" || a.status === "queued").length}`,
        `- retained children: ${listRetainedChildren(deps.retainedDir ?? ASYNC_DIR).length}`,
      ];
      return textResult(lines.join("\n"));
    }

    case "guide": {
      const topic = (args.topic as string | undefined) ?? "overview";
      return textResult(buildGuideText(topic));
    }

    case "mission.create": {
      const location = resolveMissionStoreLocation({
        projectRoot: deps.projectRoot ?? process.cwd(),
        config: deps.missionConfig,
      });
      const missionInput = (args.mission ?? {}) as Record<string, unknown>;
      const title = (missionInput.title ?? args.name) as string | undefined;
      if (!title || typeof title !== "string" || !title.trim()) {
        return textResult("action 'mission.create' requires mission.title (or name).", { status: "error" });
      }
      const objective = (missionInput.objective as string | undefined) ?? `${title}`;
      try {
        const record = createMission(location, {
          title: title.trim(),
          objective: objective.trim(),
          ...(missionInput.goal === true ? { goal: true } : {}),
          ...(missionInput.budget ? { budget: missionInput.budget as { tokens: number } } : {}),
          ...(typeof missionInput.labels === "object" ? { labels: missionInput.labels as string[] } : {}),
        });
        return textResult(
          `Mission created: ${record.id}\nTitle: ${record.title}\nStatus: ${record.status}\nAttach runs with missionId: ${record.id}`,
          { status: "completed", missionId: record.id },
        );
      } catch (error) {
        return textResult(`mission.create failed: ${error instanceof Error ? error.message : String(error)}`, { status: "error" });
      }
    }

    case "mission.list": {
      const location = resolveMissionStoreLocation({
        projectRoot: deps.projectRoot ?? process.cwd(),
        config: deps.missionConfig,
      });
      const { records, warnings } = listMissions(location);
      if (records.length === 0) return textResult("No missions for this project.");
      const lines = records.map((r) => `- ${r.id} [${r.status}] ${r.title}${r.summary ? ` — ${r.summary.slice(0, 80)}` : ""}`);
      return textResult(
        [`Missions (${records.length}):`, ...lines, ...(warnings.length ? ["", ...warnings] : [])].join("\n"),
      );
    }

    case "mission.show":
    case "mission.update":
    case "mission.resolve-decision":
    case "mission.attach-run":
    case "mission.close": {
      const missionId = args.missionId as string | undefined;
      if (!missionId) return textResult(`action '${action}' requires missionId.`, { status: "error" });
      const location = resolveMissionStoreLocation({
        projectRoot: deps.projectRoot ?? process.cwd(),
        config: deps.missionConfig,
      });
      try {
        if (action === "mission.show") {
          const record = readMission(location, missionId);
          return textResult(
            [
              `Mission ${record.id} [${record.status}]`,
              `Title: ${record.title}`,
              `Objective: ${record.objective}`,
              ...(record.goal ? [`Goal: ${record.goal.status}${record.budget ? ` (${record.usage?.tokens ?? 0}/${record.budget.tokens} tokens)` : ""}`] : []),
              `Runs: ${record.runs.length} | Decisions: ${record.decisions.filter((d) => d.status === "open").length} open / ${record.decisions.length} total`,
              ...(record.summary ? [`Summary: ${record.summary}`] : []),
              ...(record.runs.length ? ["", "Runs:", ...record.runs.map((r) => `- ${r.runId}${r.agent ? ` (${r.agent})` : ""} ${r.status ?? ""}`)] : []),
            ].join("\n"),
          );
        }
        if (action === "mission.close") {
          const summary = args.summary as string | undefined;
          const status: MissionStatus = (args.missionStatus as MissionStatus | undefined) ?? (summary ? "completed" : "cancelled");
          const record = updateMission(location, missionId, { status, ...(summary ? { summary } : {}) });
          return textResult(`Mission ${record.id} closed as ${record.status}.`, { status: "completed", missionId: record.id });
        }
        if (action === "mission.attach-run") {
          const runId = (args.runId ?? args.id) as string | undefined;
          if (!runId) return textResult("mission.attach-run requires runId (or id).", { status: "error" });
          const record = updateMission(location, missionId, {
            addRun: { runId, ...(typeof args.missionStatus === "string" ? { status: args.missionStatus } : {}) },
          });
          return textResult(`Run ${runId} attached to mission ${record.id}.`, { status: "completed", missionId: record.id });
        }
        if (action === "mission.resolve-decision") {
          const decisionId = args.id as string | undefined;
          const resolution = args.message as string | undefined;
          if (!decisionId || !resolution) {
            return textResult("mission.resolve-decision requires id (decision id) and message (resolution).", { status: "error" });
          }
          const record = updateMission(location, missionId, { resolveDecision: { id: decisionId, resolution } });
          return textResult(`Decision ${decisionId} resolved on mission ${record.id}.`, { status: "completed" });
        }
        // mission.update: generic field updates
        const record = updateMission(location, missionId, {
          ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
          ...(typeof args.missionStatus === "string" ? { status: args.missionStatus as MissionStatus } : {}),
        });
        return textResult(`Mission ${record.id} updated.`, { status: "completed", missionId: record.id });
      } catch (error) {
        if (error instanceof MissionNotFoundError) return textResult(error.message, { status: "error" });
        return textResult(`${action} failed: ${error instanceof Error ? error.message : String(error)}`, { status: "error" });
      }
    }

    case "schedule.create":
    case "schedule.list":
    case "schedule.show":
    case "schedule.history":
    case "schedule.pause":
    case "schedule.resume":
    case "schedule.run":
    case "schedule.run-due":
    case "schedule.delete": {
      if (!deps.runAsync) {
        return textResult("Schedule actions require the background process runner, which is unavailable in this host.", { status: "error" });
      }
      const manager = new ScheduledRunManager(deps.projectRoot ?? process.cwd(), {
        storeRoot: deps.config.scheduledRuns?.storeRoot,
        maxPending: deps.config.scheduledRuns?.maxPending,
        launch: async (record) => {
          const result = await deps.runAsync!({
            agentName: record.agent,
            task: record.task,
            description: `schedule: ${record.name}`,
            context: "fresh",
            timeoutMs: record.timeoutMs,
          });
          return result.runId;
        },
      });

      try {
        switch (action) {
          case "schedule.create": {
            const record = manager.create({
              name: (args.name as string | undefined) ?? `schedule-${Date.now().toString(36)}`,
              agent: (args.agent ?? args.type) as string,
              task: (args.task ?? args.prompt) as string,
              at: args.at as string | undefined,
              every: args.every as string | undefined,
              catchUp: args.catchUp as "none" | "latest" | undefined,
              timeoutMs: args.timeoutMs as number | undefined,
            });
            const next = record.trigger.kind === "once"
              ? new Date(record.trigger.atMs).toISOString()
              : record.trigger.nextRunAt;
            return textResult(
              `Schedule created: ${record.id}\nName: ${record.name}\nAgent: ${record.agent}\nTrigger: ${record.trigger.kind === "once" ? `once at ${next}` : `every ${record.trigger.every}`}\nNext run: ${next}`,
              { status: "completed", scheduleId: record.id },
            );
          }
          case "schedule.list": {
            const all = manager.list();
            if (all.length === 0) return textResult("No schedules for this project.");
            return textResult(
              [
                `Schedules (${all.length}):`,
                ...all.map((r) => {
                  const next = r.trigger.kind === "once" ? r.trigger.atMs : r.trigger.nextRunAt;
                  return `- ${r.id} "${r.name}" [${r.paused ? "paused" : "active"}] ${r.trigger.kind} → ${r.agent}: ${r.trigger.kind === "once" ? new Date(next).toISOString() : `every ${r.trigger.every}`}`;
                }),
              ].join("\n"),
            );
          }
          case "schedule.show": {
            const id = args.id as string | undefined;
            if (!id) return textResult("schedule.show requires id.", { status: "error" });
            const record = manager.show(id);
            if (!record) return textResult(`No schedule matches "${id}".`, { status: "error" });
            const history = manager.readHistory(id);
            return textResult(
              [
                `Schedule ${record.id} "${record.name}" [${record.paused ? "paused" : "active"}]`,
                `Agent: ${record.agent}`,
                `Task: ${record.task.slice(0, 200)}`,
                `Trigger: ${record.trigger.kind === "once" ? `once at ${record.trigger.at}` : `every ${record.trigger.every}`}`,
                `Overlap: ${record.overlap} | catchUp: ${record.catchUp}`,
                `Runs: ${history.length}`,
                ...history.slice(-5).map((r) => `- ${r.id} ${r.state}${r.error ? ` (${r.error})` : ""}`),
              ].join("\n"),
            );
          }
          case "schedule.history": {
            const id = args.id as string | undefined;
            if (!id) return textResult("schedule.history requires id.", { status: "error" });
            const history = manager.readHistory(id);
            if (history.length === 0) return textResult("No runs recorded for this schedule.");
            return textResult(
              ["Schedule runs (newest last):", ...history.map((r) => `- ${r.id} ${r.state} ${r.plannedAt}${r.error ? ` (${r.error})` : ""}`)].join("\n"),
            );
          }
          case "schedule.pause":
          case "schedule.resume": {
            const id = args.id as string | undefined;
            if (!id) return textResult(`${action} requires id.`, { status: "error" });
            const record = manager.setPaused(id, action === "schedule.pause");
            return textResult(`Schedule ${record.id} "${record.name}" ${record.paused ? "paused" : "resumed"}.`);
          }
          case "schedule.run": {
            const id = args.id as string | undefined;
            if (!id) return textResult("schedule.run requires id.", { status: "error" });
            const run = await manager.runNow(id);
            return textResult(
              run.state === "completed"
                ? `Schedule ran: async run ${run.asyncRunId}`
                : `Schedule run ${run.state}${run.error ? `: ${run.error}` : ""}`,
              { status: run.state === "completed" ? "completed" : "error" },
            );
          }
          case "schedule.run-due": {
            const runs = await manager.runDue();
            return textResult(`${runs.length} due schedule(s) executed.`);
          }
          case "schedule.delete": {
            const id = args.id as string | undefined;
            if (!id) return textResult("schedule.delete requires id.", { status: "error" });
            const removed = manager.delete(id);
            return textResult(removed ? `Schedule ${id} deleted.` : `No schedule matches "${id}".`, { status: removed ? "completed" : "error" });
          }
          default:
            return textResult(`Unknown schedule action.`, { status: "error" });
        }
      } catch (error) {
        return textResult(`${action} failed: ${error instanceof Error ? error.message : String(error)}`, { status: "error" });
      }
    }

    default:
      // Actions that belong to later phases report their status clearly.
      return textResult(
        `action "${action}" is recognized but not yet implemented in this build (planned phase).`,
        { status: "error" },
      );
  }
}

// ============================================================================
// workflowScript execution (foreground)
// ============================================================================

async function handleWorkflowScript(
  deps: HandlerDeps,
  ctx: ExtensionContext,
  script: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
  const asyncRequested = (args.async as boolean | undefined) ?? deps.config.asyncByDefault ?? true;
  if (asyncRequested) {
    return handleAsyncWorkflowScript(deps, ctx, script, args, signal);
  }

  // Validate call-level budgets up front (reference behavior).
  if (args.turnBudget !== undefined) {
    const { error } = resolveTurnBudgetConfig(args.turnBudget);
    if (error) return textResult(error, { status: "error" });
  }
  if (args.toolBudget !== undefined) {
    const { error } = validateToolBudgetConfig(args.toolBudget);
    if (error) return textResult(error, { status: "error" });
  }
  if (args.usageBudget !== undefined) {
    const { error } = validateUsageBudgetConfig(args.usageBudget);
    if (error) return textResult(error, { status: "error" });
  }

  // Spawn budget: one fanout budget per top-level workflow run.
  const perRunCap = deps.config.maxSubagentSpawnsPerRun ?? 64;
  const budget = createRunFanoutBudget(`workflow-${Date.now()}`, perRunCap);

  const sessionAccounting = deps.spawnAccounting;
  const sessionCap = sessionAccounting?.cap();

  const admit = (calls: Array<{ key: string; params: Record<string, unknown> }>): void => {
    if (calls.length === 0) return;
    // Per-run budget: atomic group admission.
    claimRunFanoutBatch(budget, calls.map((call) => call.key));
    // Session budget: cumulative.
    if (sessionCap !== undefined && sessionAccounting) {
      const used = sessionAccounting.used();
      if (used + calls.length > sessionCap) {
        throw new Error(
          `Session spawn budget exhausted: ${used}/${sessionCap} used, ${calls.length} requested. ` +
            `Use spawn_helper ({ action: "grant-spawn-budget", additional: N }) from the interactive parent to extend.`,
        );
      }
      sessionAccounting.consume(calls.length);
    }
  };

  const launch = async (
    key: string,
    params: Record<string, unknown>,
    childSignal: AbortSignal,
  ): Promise<WorkflowScriptChildResult> => {
    const agentNameRaw = params.agent as string | undefined;
    const task = params.task as string | undefined;
    if (!agentNameRaw || !task) {
      return { key, ok: false, output: "runs.run requires agent and task.", error: "missing agent/task", artifactPaths: [] };
    }
    const agentName = deps.manager.resolveAlias(agentNameRaw);
    const agent = deps.manager.getAgentConfig(agentName);
    if (!agent) {
      return { key, ok: false, output: `Unknown agent "${agentNameRaw}".`, error: "unknown agent", artifactPaths: [] };
    }
    if (!deps.manager.isTypeEnabled(agentName)) {
      return { key, ok: false, output: `Agent "${agentName}" is disabled.`, error: "disabled", artifactPaths: [] };
    }

    // Context policy (foreground = fresh only).
    const contextMode = resolveContext(params.context as string | undefined, agent, deps.config);
    if (contextMode === "fork") {
      return {
        key,
        ok: false,
        output: 'context "fork" requires background execution; foreground workflow children are fresh-context.',
        error: "fork unavailable in foreground",
        artifactPaths: [],
      };
    }

    // Turn budget: wrap-up block in the child prompt.
    let childTask = task;
    const turnBudgetResult = resolveTurnBudgetConfig(params.turnBudget ?? args.turnBudget);
    if (turnBudgetResult.turnBudget) {
      childTask = appendTurnBudgetSystemPrompt(task, turnBudgetResult.turnBudget);
    }

    // Boundary instructions (plain or fanout child).
    childTask = withChildBoundaryInstructions(childTask, agent);

    const result = await deps.spawnForeground(ctx, agentName, childTask, {
      description: (params.label as string | undefined) ?? key,
      maxTurns: (params.maxTurns as number | undefined) ?? (turnBudgetResult.turnBudget?.maxTurns),
      modelInput: (params.model as string | undefined) ?? agent.model,
      thinkingLevel: agent.thinking,
      signal: childSignal,
    });

    return {
      key,
      ok: result.ok,
      output: result.output,
      ...(result.error ? { error: result.error } : {}),
      ...(agentName ? { agent: agentName } : {}),
      artifactPaths: [],
    };
  };

  const status = async (keyOrRunId: string): Promise<WorkflowScriptChildResult> => {
    const record = deps.manager.getRecord(keyOrRunId);
    if (record) {
      return {
        key: keyOrRunId,
        ok: record.status === "completed",
        output: record.result ?? record.status,
        ...(record.error ? { error: record.error } : {}),
        artifactPaths: [],
      };
    }
    return { key: keyOrRunId, ok: true, output: "ok", artifactPaths: [] };
  };

  try {
    const result = await runWorkflowScript({
      script,
      timeoutMs: args.timeoutMs as number | undefined,
      signal,
      admit,
      launch,
      status,
    });

    const maxOutput = resolveMaxOutput(args.maxOutput as never, deps.config);
    const summary =
      typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2) ?? "null";
    const truncated = truncateOutput(summary, maxOutput);
    return textResult(truncated.text, {
      status: "completed",
      children: result.children.length,
      fanout: formatRunFanoutBudget(getRunFanoutBudgetSnapshot(budget)),
      truncated: truncated.truncated,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "WorkflowScriptError") {
      const partial = (error as { partial?: { children?: unknown[] } }).partial;
      return textResult(
        `Workflow failed: ${error.message}`,
        { status: "error", children: partial?.children?.length ?? 0 },
      );
    }
    throw error;
  }
}

// ============================================================================
// Single-child launch (legacy + reference)
// ============================================================================

async function handleSingleChild(
  deps: HandlerDeps,
  ctx: ExtensionContext,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
  const pre = preflight(deps, args);
  if (!pre.ok) return textResult(pre.error, { status: "error" });

  const { agent, agentName, prompt } = pre;
  const asyncRequested =
    (args.async as boolean | undefined) ??
    (args.run_in_background as boolean | undefined) ??
    agent.runInBackground ??
    false;

  // Context policy. EXPLICIT fork never silently downgrades (reference rule);
  // implicit fork (agent/config default) falls back to fresh when the in-process
  // path cannot fork (reference: implicit fork needs a persisted parent session,
  // else fresh).
  const explicitContext = args.context as string | undefined;
  const contextMode = resolveContext(explicitContext, agent, deps.config);
  if (contextMode === "fork" && (explicitContext === "fork" || deps.config.defaultSubagentContext === "fork")) {
    if (!asyncRequested) {
      return textResult(
        'context: "fork" requires background execution (run_in_background: true); the in-process foreground path is fresh-context only.',
        { status: "error" },
      );
    }
    if (!deps.runAsync) {
      return textResult(
        'context: "fork" requires the background process runner, which is unavailable in this host. Re-run without context, or use context: "fresh".',
        { status: "error" },
      );
    }
  }

  // Budgets: validate + decorate.
  let childPrompt = prompt;
  const turnBudgetResult = resolveTurnBudgetConfig(args.turnBudget);
  if (turnBudgetResult.error) return textResult(turnBudgetResult.error, { status: "error" });
  if (turnBudgetResult.turnBudget) {
    childPrompt = appendTurnBudgetSystemPrompt(childPrompt, turnBudgetResult.turnBudget);
  }
  const toolBudgetResult = validateToolBudgetConfig(args.toolBudget);
  if (toolBudgetResult.error) return textResult(toolBudgetResult.error, { status: "error" });
  const usageBudgetResult = validateUsageBudgetConfig(args.usageBudget);
  if (usageBudgetResult.error) return textResult(usageBudgetResult.error, { status: "error" });

  // Boundary instructions (unless the agent is a fanout child).
  if (!isFanoutChild(agent)) {
    childPrompt = withChildBoundaryInstructions(childPrompt, agent);
  }

  // Session spawn budget.
  const sessionAccounting = deps.spawnAccounting;
  if (sessionAccounting) {
    const cap = sessionAccounting.cap();
    if (cap !== undefined && sessionAccounting.used() >= cap) {
      return textResult(
        `Session spawn budget exhausted: ${sessionAccounting.used()}/${cap} used. ` +
          `Use spawn_helper ({ action: "grant-spawn-budget", additional: N }) from the interactive parent to extend.`,
        { status: "error" },
      );
    }
    sessionAccounting.consume(1);
  }

  const description = (args.description as string | undefined) ?? `${agentName} task`;

  if (asyncRequested) {
    // Fork context requires the process runner; fresh background runs prefer
    // it too when available (survives parent exit), else fall back in-process.
    const wantsProcessRunner = contextMode === "fork" || deps.config.asyncByDefault === true;
    if (deps.runAsync && (contextMode === "fork" || wantsProcessRunner)) {
      const result = await deps.runAsync({
        agentName,
        task: childPrompt,
        description,
        model: (args.model as string | undefined) ?? agent.model,
        thinking: (args.thinking as string | undefined) ?? (typeof agent.thinking === "string" ? agent.thinking : undefined),
        context: contextMode,
        timeoutMs: (args.timeoutMs as number | undefined) ?? agent.timeoutMs,
        maxTurns: (args.max_turns as number | undefined) ?? (args.maxTurns as number | undefined) ?? turnBudgetResult.turnBudget?.maxTurns,
      });
      return textResult(
        `Agent started in background (process mode).\nRun ID: ${result.runId}\nType: ${agentName}\nDescription: ${description}\n\nYou will be notified when this agent completes.\nUse get_helper_result with the run ID to retrieve results.`,
        { status: "background", runId: result.runId, agentId: result.runId },
      );
    }
    const id = deps.spawnBackground(ctx, agentName, childPrompt, {
      description,
      maxTurns: (args.max_turns as number | undefined) ?? (args.maxTurns as number | undefined) ?? turnBudgetResult.turnBudget?.maxTurns,
      modelInput: (args.model as string | undefined) ?? agent.model,
      thinkingLevel: args.thinking ?? agent.thinking,
    });
    return textResult(
      `Agent started in background.\nID: ${id}\nType: ${agentName}\nDescription: ${description}\n\nYou will be notified when this agent completes.\nUse get_helper_result to retrieve full results.`,
      { status: "background", agentId: id },
    );
  }

  const result = await deps.spawnForeground(ctx, agentName, childPrompt, {
    description,
    maxTurns: (args.max_turns as number | undefined) ?? (args.maxTurns as number | undefined) ?? turnBudgetResult.turnBudget?.maxTurns,
    modelInput: (args.model as string | undefined) ?? agent.model,
    thinkingLevel: args.thinking ?? agent.thinking,
    signal,
  });

  if (!result.ok) {
    return textResult(`Agent failed: ${result.error ?? result.output}`, {
      status: "error",
      error: result.error,
      toolUses: result.toolUses,
      durationMs: result.durationMs,
    });
  }

  // Output truncation with maxOutput config (reference default 200KB/5000 lines).
  const maxOutput = resolveMaxOutput(args.maxOutput as never, deps.config);
  const truncated = truncateOutput(result.output, maxOutput);

  return textResult(
    `Agent completed in ${(result.durationMs / 1000).toFixed(1)}s (${result.toolUses} tool uses).\n\n${truncated.text}`,
    {
      status: "completed",
      toolUses: result.toolUses,
      durationMs: result.durationMs,
      truncated: truncated.truncated,
      originalBytes: truncated.originalBytes,
    },
  );
}


// ============================================================================
// Async workflowScript (process-backed children)
// ============================================================================

/**
 * Run a workflow with every child launched through the process runner
 * (child pi processes). The workflow runtime is identical; only the launch
 * transport differs. The tool call blocks until the workflow settles — the
 * parent gets the full result. (Fully detached async workflows with live
 * status polling land with the Phase 4 fleet work.)
 */
async function handleAsyncWorkflowScript(
  deps: HandlerDeps,
  ctx: ExtensionContext,
  script: string,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }> {
  if (!deps.runAsync) {
    return textResult(
      "Async workflowScript requires the background process runner, which is unavailable in this host. " +
        "Re-run with async: false to execute the workflow in-process in the foreground.",
      { status: "error" },
    );
  }

  // Validate call-level budgets up front.
  if (args.turnBudget !== undefined) {
    const { error } = resolveTurnBudgetConfig(args.turnBudget);
    if (error) return textResult(error, { status: "error" });
  }
  if (args.toolBudget !== undefined) {
    const { error } = validateToolBudgetConfig(args.toolBudget);
    if (error) return textResult(error, { status: "error" });
  }
  if (args.usageBudget !== undefined) {
    const { error } = validateUsageBudgetConfig(args.usageBudget);
    if (error) return textResult(error, { status: "error" });
  }

  const perRunCap = deps.config.maxSubagentSpawnsPerRun ?? 64;
  const budget = createRunFanoutBudget(`workflow-async-${Date.now()}`, perRunCap);
  const sessionAccounting = deps.spawnAccounting;
  const sessionCap = sessionAccounting?.cap();

  const admit = (calls: Array<{ key: string; params: Record<string, unknown> }>): void => {
    if (calls.length === 0) return;
    claimRunFanoutBatch(budget, calls.map((call) => call.key));
    if (sessionCap !== undefined && sessionAccounting) {
      const used = sessionAccounting.used();
      if (used + calls.length > sessionCap) {
        throw new Error(
          `Session spawn budget exhausted: ${used}/${sessionCap} used, ${calls.length} requested.`,
        );
      }
      sessionAccounting.consume(calls.length);
    }
  };

  const launch = async (
    key: string,
    params: Record<string, unknown>,
    childSignal: AbortSignal,
  ): Promise<WorkflowScriptChildResult> => {
    const agentNameRaw = params.agent as string | undefined;
    const task = params.task as string | undefined;
    if (!agentNameRaw || !task) {
      return { key, ok: false, output: "runs.run requires agent and task.", error: "missing agent/task", artifactPaths: [] };
    }
    const agentName = deps.manager.resolveAlias(agentNameRaw);
    const agent = deps.manager.getAgentConfig(agentName);
    if (!agent) {
      return { key, ok: false, output: `Unknown agent "${agentNameRaw}".`, error: "unknown agent", artifactPaths: [] };
    }
    if (!deps.manager.isTypeEnabled(agentName)) {
      return { key, ok: false, output: `Agent "${agentName}" is disabled.`, error: "disabled", artifactPaths: [] };
    }

    // Context policy: fork children get branched sessions via the process runner.
    const contextMode = resolveContext(params.context as string | undefined, agent, deps.config);

    let childTask = task;
    const turnBudgetResult = resolveTurnBudgetConfig(params.turnBudget ?? args.turnBudget);
    if (turnBudgetResult.turnBudget) {
      childTask = appendTurnBudgetSystemPrompt(task, turnBudgetResult.turnBudget);
    }
    childTask = withChildBoundaryInstructions(childTask, agent);

    try {
      const worktreeRequested =
        (params.worktree as boolean | undefined) ??
        (args.worktree as boolean | undefined) ??
        (args.isolation === "worktree" ? true : undefined);
      const result = await deps.runAsync!({
        agentName,
        task: childTask,
        description: (params.label as string | undefined) ?? key,
        model: (params.model as string | undefined) ?? agent.model,
        thinking: typeof agent.thinking === "string" ? agent.thinking : undefined,
        context: contextMode,
        timeoutMs: (params.timeoutMs as number | undefined) ?? agent.timeoutMs,
        maxTurns: (params.maxTurns as number | undefined) ?? turnBudgetResult.turnBudget?.maxTurns,
        ...(worktreeRequested === true ? { worktree: true } : {}),
      });
      void childSignal; // process-level abort handled by the runner's controller
      return {
        key,
        ok: result.status === "completed",
        output: result.output ?? result.error ?? result.status,
        ...(result.error ? { error: result.error } : {}),
        agent: agentName,
        ...(result.runId ? { runId: result.runId } : {}),
        artifactPaths: [],
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { key, ok: false, output: text, error: text, artifactPaths: [] };
    }
  };

  const status = async (keyOrRunId: string): Promise<WorkflowScriptChildResult> => {
    const record = deps.manager.getRecord(keyOrRunId);
    if (record) {
      return {
        key: keyOrRunId,
        ok: record.status === "completed",
        output: record.result ?? record.status,
        ...(record.error ? { error: record.error } : {}),
        artifactPaths: [],
      };
    }
    return { key: keyOrRunId, ok: true, output: "ok", artifactPaths: [] };
  };

  try {
    const result = await runWorkflowScript({
      script,
      timeoutMs: args.timeoutMs as number | undefined,
      signal,
      admit,
      launch,
      status,
    });

    const maxOutput = resolveMaxOutput(args.maxOutput as never, deps.config);
    const summary =
      typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2) ?? "null";
    const truncated = truncateOutput(summary, maxOutput);
    return textResult(truncated.text, {
      status: "completed",
      mode: "async-workflow",
      children: result.children.length,
      fanout: formatRunFanoutBudget(getRunFanoutBudgetSnapshot(budget)),
      truncated: truncated.truncated,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "WorkflowScriptError") {
      const partial = (error as { partial?: { children?: unknown[] } }).partial;
      return textResult(
        `Workflow failed: ${error.message}`,
        { status: "error", mode: "async-workflow", children: partial?.children?.length ?? 0 },
      );
    }
    throw error;
  }
}
