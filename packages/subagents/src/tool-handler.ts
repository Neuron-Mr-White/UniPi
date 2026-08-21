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
      return handleAction(deps, ctx, action, args);
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

function handleAction(
  deps: HandlerDeps,
  _ctx: ExtensionContext,
  action: string,
  args: Record<string, unknown>,
): { content: Array<{ type: "text"; text: string }>; details?: unknown } {
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
      const recent = deps.manager
        .listAgents()
        .filter((a) => a.status !== "running" && a.status !== "queued")
        .slice(-10);
      if (recent.length === 0) return textResult("No completed children in this session yet.");
      return textResult(
        recent
          .map((r) => `- ${r.id} [${r.type}] ${r.status}: ${r.description}`)
          .join("\n"),
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
      return textResult(
        [
          `Subagents doctor (${new Date().toISOString()})`,
          `Config: ${deps.config.enabled ? "enabled" : "DISABLED"} | maxConcurrent=${deps.config.maxConcurrent}`,
          `Known agent types: ${deps.manager.getKnownTypes().length}`,
          `Disabled types: ${deps.manager.getKnownTypes().filter((t) => !deps.manager.isTypeEnabled(t)).join(", ") || "none"}`,
          `Run timeout default: ${deps.config.timeoutMs ?? "30min (default)"}`,
          `Tool timeout: ${deps.config.toolTimeoutMs ?? "env/known-fast defaults"}`,
          `Spawn caps: run=${deps.config.maxSubagentSpawnsPerRun ?? 64}, session=${deps.config.maxSubagentSpawnsPerSession ?? "unlimited"}, active-async=${deps.config.maxActiveAsyncRunsPerSession ?? "unlimited"}`,
          `Depth cap: ${resolveMaxSubagentDepth(undefined, deps.config, deps.env ?? process.env)}`,
        ].join("\n"),
      );
    }

    case "guide": {
      const topic = (args.topic as string | undefined) ?? "overview";
      return textResult(
        `Guide topic "${topic}" is not bundled yet — see the subagents README. ` +
          `Available topics: overview, workflows, agents, missions, observability, tool-reference, configuration, models, watchdog, extension-api.`,
      );
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
  // Async workflows need the process runner.
  const asyncRequested = (args.async as boolean | undefined) ?? deps.config.asyncByDefault ?? true;
  if (asyncRequested) {
    return textResult(
      "Async workflowScript requires the background runner, which is not yet wired for workflows. " +
        "Re-run with async: false to execute the workflow in-process in the foreground.",
      { status: "error" },
    );
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
