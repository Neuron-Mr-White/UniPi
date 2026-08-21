/**
 * @pi-unipi/subagents — Parity types (pi-subagents v0.53.0 feature surface)
 *
 * Ported from nicobailon/pi-subagents src/shared/types.ts. Semantics follow
 * the reference; naming and on-disk layout follow unipi conventions:
 *   - runtime artifacts under os.tmpdir()/unipi-subagents-<scope>
 *   - env overrides use UNIPI_SUBAGENT_* (not PI_SUBAGENT_*)
 *   - tool surface stays spawn_helper / get_helper_result
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";

// ============================================================================
// Output / truncation
// ============================================================================

export interface MaxOutputConfig {
  bytes?: number;
  lines?: number;
}

export type OutputMode = "inline" | "file-only";

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
  bytes: 200 * 1024,
  lines: 5000,
};

// ============================================================================
// Budgets
// ============================================================================

export interface TurnBudgetConfig {
  maxTurns?: number;
  graceTurns?: number;
}

export interface ResolvedTurnBudget {
  maxTurns: number;
  graceTurns: number;
}

export type TurnBudgetOutcome =
  | "within-budget"
  | "wrap-up-requested"
  | "termination-deferred"
  | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
  turns: number;
  outcome: TurnBudgetOutcome;
}

export interface ToolBudgetConfig {
  soft?: number;
  hard: number;
  block?: string[] | "*";
}

export interface ResolvedToolBudget {
  soft?: number;
  hard: number;
  block: string[];
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
  toolCalls: number;
  outcome: ToolBudgetOutcome;
}

export interface UsageBudgetConfig {
  tokens?: { soft?: number; hard?: number };
  costUsd?: { soft?: number; hard?: number };
}

// ============================================================================
// Run / result states
// ============================================================================

export type SubagentRunMode = "single" | "parallel" | "chain" | "workflow";

export type SubagentResultStatus =
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "detached";

export type SubagentOutputState = "present" | "absent" | "unknown";

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "stopped"
  | "detached"
  | "rejected";

export type ProcessTerminalState = "pending" | "observed" | "unknown" | "not-started";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export type ContextMode = "fresh" | "fork";

export type IsolationMode = "none" | "worktree";

// ============================================================================
// Config sub-objects (ExtensionConfig pieces we port into our subagents.json)
// ============================================================================

export type FleetViewPlacement = "belowEditor" | "aboveEditor";

export type ToolDescriptionMode = "default" | "full" | "compact" | "custom";

export type InlineToolDisplay = "rich" | "summary";

export interface MainWindowRendererConfig {
  horizontalSpacing?: number;
  compactResultMaxLines?: number;
}

export interface WaitToolConfigObject {
  enabled?: boolean;
}

export type WaitToolConfig = boolean | WaitToolConfigObject;

export interface TopLevelParallelConfig {
  maxTasks?: number;
  concurrency?: number;
}

export interface ResultScanLoggingConfig {
  mode: "all" | "activity" | "off";
}

// ============================================================================
// Constants — artifact layout (temp-scoped like the reference, unipi-named)
// ============================================================================

function sanitizeScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

/** Stable per-user temp scope so concurrent users never share artifacts. */
export function resolveTempScopeId(options?: {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
}): string {
  const env = options?.env ?? process.env;
  const getuid =
    options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === "function") return `uid-${getuid()}`;
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeScopeSegment(value)}`;
  }
  try {
    const username = userInfo().username;
    if (username) return `user-${sanitizeScopeSegment(username)}`;
  } catch {
    // fall through
  }
  const home = env.USERPROFILE ?? env.HOME;
  if (home) return `home-${sanitizeScopeSegment(home)}`;
  return "shared";
}

const configuredTempRoot = process.env.UNIPI_SUBAGENTS_TEMP_ROOT?.trim();
export const TEMP_ROOT_DIR = configuredTempRoot
  ? join(configuredTempRoot)
  : join(tmpdir(), `unipi-subagents-${resolveTempScopeId()}`);

export const RESULTS_DIR = join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = join(TEMP_ROOT_DIR, "async-subagent-runs");
export const CHAIN_RUNS_DIR = join(TEMP_ROOT_DIR, "chain-runs");
export const TEMP_ARTIFACTS_DIR = join(TEMP_ROOT_DIR, "artifacts");

export const DIRS = {
  results: RESULTS_DIR,
  async: ASYNC_DIR,
  chain: CHAIN_RUNS_DIR,
  artifacts: TEMP_ARTIFACTS_DIR,
} as const;

export function ensureDirs(): void {
  for (const dir of Object.values(DIRS)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Widget / render constants
// ============================================================================

export const WIDGET_KEY_ASYNC = "unipi-agents-async";
export const MAX_WIDGET_JOBS = 4;
export const POLL_INTERVAL_MS = 250;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const DEFAULT_MAX_SUBAGENTS_PER_RUN = 64;
export const MAX_PARALLEL_TASKS = 8;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20;

/** Foreground backstop when nothing else configures a deadline. */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
/** Hard per-tool deadline for known-fast built-in tools when toolTimeoutMs unset. */
export const FAST_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
export const KNOWN_FAST_TOOLS = ["read", "grep", "find", "ls", "edit", "write"] as const;

// ============================================================================
// Events (unipi event bus payloads for async lifecycle)
// ============================================================================

export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";
export const SUBAGENT_CONTROL_EVENT = "subagent:control";

/**
 * Actions accepted by spawn_helper. Ported from SUBAGENT_ACTIONS; names kept
 * identical (they are parameter values, not tool names — no convention clash).
 * Actions land phase by phase; unimplemented ones return a clear error.
 */
export const SUBAGENT_ACTIONS = [
  "list",
  "get",
  "children.list",
  "guide",
  "create",
  "update",
  "delete",
  "eject",
  "disable",
  "enable",
  "reset",
  "mission.create",
  "mission.list",
  "mission.show",
  "mission.update",
  "mission.resolve-decision",
  "mission.attach-run",
  "mission.close",
  "worktree.discard",
  "refine",
  "refine.show",
  "refine.rollback",
  "inspector.open",
  "inspector.status",
  "inspector.close",
  "project.open",
  "project.status",
  "project.close",
  "status",
  "debug.run",
  "grant-spawn-budget",
  "interrupt",
  "resume",
  "steer",
  "stop",
  "dismiss",
  "doctor",
  "watchdog.status",
  "watchdog.check",
  "watchdog.configure",
  "watchdog.recommend-model",
  "schedule.create",
  "schedule.list",
  "schedule.show",
  "schedule.history",
  "schedule.pause",
  "schedule.resume",
  "schedule.run",
  "schedule.run-due",
  "schedule.delete",
] as const;

export type SubagentAction = (typeof SUBAGENT_ACTIONS)[number];

export const GUIDE_TOPICS = [
  "overview",
  "workflows",
  "agents",
  "missions",
  "observability",
  "tool-reference",
  "configuration",
  "models",
  "watchdog",
  "extension-api",
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];
