/**
 * @pi-unipi/subagents — Tool parameter schemas (pi-subagents parity)
 *
 * Ported from nicobailon/pi-subagents src/extension/schemas.ts. Parameter
 * names follow the reference (they are arguments, not tool names — no
 * convention clash); our legacy spawn_helper params (type/prompt/description/
 * run_in_background/max_turns) remain accepted as aliases.
 */

import { Type } from "typebox";

const TurnBudgetOverride = Type.Object(
  {
    maxTurns: Type.Integer({ minimum: 1 }),
    graceTurns: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  {
    additionalProperties: false,
    description:
      "Optional assistant-turn budget. At maxTurns the child is asked to wrap up; after graceTurns (default 1) additional assistant turns it is aborted and partial output is returned.",
  },
);

const ToolBudgetBlock = Type.Unsafe({
  anyOf: [
    { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    { type: "string", enum: ["*"] },
  ],
});

const ToolBudgetOverride = Type.Object(
  {
    soft: Type.Optional(Type.Integer({ minimum: 1 })),
    hard: Type.Integer({ minimum: 1 }),
    block: Type.Optional(ToolBudgetBlock),
  },
  {
    additionalProperties: false,
    description:
      "Optional child tool-call budget. soft nudges the child to finalize; after hard, block tools (default read/grep/find/ls, or '*' for all tools) are blocked so the child can finalize. Final assistant text is never blocked.",
  },
);

const UsageBudgetLimitOverride = Type.Object(
  {
    soft: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    hard: Type.Number({ exclusiveMinimum: 0 }),
  },
  { additionalProperties: false },
);

const UsageBudgetOverride = Type.Object(
  {
    tokens: Type.Optional(UsageBudgetLimitOverride),
    costUsd: Type.Optional(UsageBudgetLimitOverride),
  },
  {
    additionalProperties: false,
    description:
      "Optional root-only reported-usage budget. Soft limits are status-only. Hard limits prevent later child launches after usage is reconciled; running children are not stopped.",
  },
);

const MaxOutputOverride = Type.Object(
  {
    bytes: Type.Optional(Type.Integer({ minimum: 1 })),
    lines: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false, description: "Final output truncation limits. Defaults: 200KB / 5000 lines." },
);

/**
 * spawn_helper parameter surface. Legacy fields (type, prompt, description,
 * run_in_background, max_turns) are the unipi convention and stay primary;
 * reference fields (agent, task, action, workflowScript, budgets, ...) join
 * them. Execution paths map: agent→type, task→prompt, async→run_in_background.
 */
export const SpawnHelperParams = Type.Object({
  // ---- unipi legacy (preserved) ----
  type: Type.Optional(
    Type.String({ description: "Agent type (alias of agent). Enabled builtin or custom type." }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "The task for the agent to perform (alias of task)." }),
  ),
  description: Type.Optional(
    Type.String({ description: "A short (3-5 word) description of the task." }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({ description: "Run in background (alias of async). Returns helper ID immediately." }),
  ),
  max_turns: Type.Optional(
    Type.Number({ minimum: 1, description: "Max agentic turns before stopping." }),
  ),

  // ---- reference surface ----
  agent: Type.Optional(
    Type.String({ description: "Agent for one-child execution, or target for management actions." }),
  ),
  task: Type.Optional(
    Type.String({
      description: "Optional one-child task. Requires agent; cannot combine with action or workflowScript.",
    }),
  ),
  action: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Optional management/control action (list, get, status, steer, stop, doctor, ...). Omit for execution.",
    }),
  ),
  id: Type.Optional(Type.String({ description: "Run id/prefix for status, interrupt, steer." })),
  runId: Type.Optional(Type.String({ description: "Target run ID. Prefer id." })),
  dir: Type.Optional(Type.String({ description: "Async run directory for status/stop/resume/steer." })),
  index: Type.Optional(
    Type.Integer({ minimum: 0, description: "Zero-based child index for actions targeting a specific child." }),
  ),
  view: Type.Optional(
    Type.String({
      enum: ["fleet", "transcript"],
      description: "Optional status view: fleet surface or transcript tail.",
    }),
  ),
  lines: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 500, description: "Max transcript lines for status view=transcript. Default 80." }),
  ),
  topic: Type.Optional(Type.String({ description: "Guide topic for action=guide." })),
  message: Type.Optional(
    Type.String({ description: "Follow-up message for resume, live guidance for steer." }),
  ),
  mode: Type.Optional(
    Type.String({
      enum: ["steer", "follow_up", "auto"],
      description: "Delivery mode for action=steer.",
    }),
  ),
  additional: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Positive launches to add with action=grant-spawn-budget.",
    }),
  ),
  missionId: Type.Optional(Type.String({ description: "Mission id." })),
  mission: Type.Optional(
    Type.Unsafe({
      anyOf: [{ type: "object", additionalProperties: true }, { type: "boolean", enum: [false] }],
      description: "Mission object, or false for no mission.",
    }),
  ),
  config: Type.Optional(
    Type.Unsafe({
      anyOf: [{ type: "object", additionalProperties: true }, { type: "string" }],
      description: "Agent config for create/update. Object or JSON string.",
    }),
  ),
  workflowScript: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Trusted inline JavaScript statement body. Use await runs.run(key, {agent, task}) for one child, runs.all([...]) for parallel fanout, await runs.steer(key, message, opts) to steer. Plain helper functions or explicit Promise chains only; nested async helpers are rejected. Explicit return for output. async:true for background (default), async:false only when the parent must block.",
    }),
  ),
  chatProgress: Type.Optional(
    Type.String({
      enum: ["auto", "off", "live-card"],
      description: "WorkflowScript chat progress projection.",
    }),
  ),
  isolation: Type.Optional(
    Type.String({ enum: ["none", "worktree"], description: "Workflow child isolation." }),
  ),
  worktree: Type.Optional(
    Type.Boolean({ description: "Managed child isolation via separate git worktrees." }),
  ),
  context: Type.Optional(
    Type.String({
      enum: ["fresh", "fork", "profile"],
      description:
        "'fresh' or 'fork' to branch from parent session, or 'profile' for the agent's declared defaultContext.",
    }),
  ),
  async: Type.Optional(
    Type.Boolean({ description: "Run in background. Set false only when the parent must block." }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, description: "Run-level max runtime ms. Alias maxRuntimeMs." }),
  ),
  maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1, description: "Alias timeoutMs." })),
  toolTimeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, description: "Optional hard per-tool-call timeout in ms." }),
  ),
  turnBudget: Type.Optional(TurnBudgetOverride),
  toolBudget: Type.Optional(ToolBudgetOverride),
  usageBudget: Type.Optional(UsageBudgetOverride),
  agentScope: Type.Optional(
    Type.String({
      description: "Agent discovery scope: 'user', 'project', or 'both' (default both; project wins collisions).",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Execution cwd override." })),
  artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts. Default true." })),
  includeProgress: Type.Optional(
    Type.Boolean({ description: "Include full progress in result. Default false." }),
  ),
  sessionDir: Type.Optional(Type.String({ description: "Directory for child session logs." })),
  output: Type.Optional(
    Type.Unsafe({
      anyOf: [{ type: "string" }, { type: "boolean" }],
      description: "Default child output file (string), or false to disable.",
    }),
  ),
  outputMode: Type.Optional(
    Type.String({
      enum: ["inline", "file-only"],
      description: "Return saved output inline (default) or only a concise file reference.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: 'Model override. "provider/modelId" or fuzzy name. Omit to inherit parent model.',
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description: "Thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit parent.",
    }),
  ),
  maxOutput: Type.Optional(MaxOutputOverride),
});

/** get_helper_result parameter surface (parity with subagent_wait). */
export const GetHelperResultParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Helper/async run id (or prefix) to wait for. Omit to wait across every active run started in this session.",
    }),
  ),
  nonBlocking: Type.Optional(
    Type.Boolean({
      description:
        "When true, resolve id to one exact run, persist a wake subscription, and return immediately. The originating session is woken on completion/failure/attention. Requires id; cannot combine with all.",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({
      description:
        "Wait for ALL active runs to finish. Default false: return when the first run finishes.",
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Give up waiting after this many milliseconds (runs keep going). Default 1800000.",
    }),
  ),
  stopOnAttention: Type.Optional(
    Type.Boolean({
      description:
        "Blocking waits stop when a run needs attention by default. Set false to wait through idle or long-thinking attention.",
    }),
  ),
});
