/**
 * @pi-unipi/subagents — Type definitions
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type { ThinkingLevel };

/** Agent type name: built-in or user-defined. */
export type AgentType = string;

/** Built-in agent type names. */
export const BUILTIN_TYPES = ["explore", "work"] as const;

/** Read-only tool names for explore agents. */
const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

/** All write-capable tool names. */
const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Built-in agent configurations. */
export const BUILTIN_CONFIGS: Record<string, AgentConfig> = {
  explore: {
    name: "explore",
    displayName: "Explore",
    description: "Read-only exploration agent for parallel file reads and searches.",
    builtinToolNames: READ_ONLY_TOOLS,
    disallowedTools: ["edit", "write"],
    extensions: false,
    skills: false,
    systemPrompt: "You are an explore agent. Read files, search code, and report findings. Do NOT modify any files.",
    promptMode: "append",
    source: "builtin",
  },
  work: {
    name: "work",
    displayName: "Worker",
    description: "Write-capable worker agent with transparent file locking.",
    builtinToolNames: ALL_TOOLS,
    extensions: false,
    skills: false,
    systemPrompt: "You are a worker agent. Implement changes, write code, and complete tasks. Use the provided tools to make the requested modifications.",
    promptMode: "append",
    source: "builtin",
  },
  "name-gen": {
    name: "name-gen",
    displayName: "Name Generator",
    description: "Minimal agent for generating session names from conversation context.",
    builtinToolNames: [],
    extensions: false,
    skills: false,
    systemPrompt: "You are a session name generator. Generate concise titles from conversation context. Reply with ONLY the title.",
    promptMode: "replace",
    source: "builtin",
  },
} as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Structured per-agent memory config (reference parity). */
export interface AgentMemoryConfig {
  scope: "user" | "project";
  path: string;
}

/** Unified agent configuration. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Alias names resolving to this agent (reference parity). */
  aliases?: string[];
  builtinToolNames?: string[];
  disallowedTools?: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  /** Extra skill directories to load for this agent. */
  skillPath?: string[];
  model?: string;
  /** Ordered fallback models (reference parity; resolved Phase 2). */
  fallbackModels?: string[];
  thinking?: ThinkingLevel | string | false;
  maxTurns?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Reference alias for promptMode. */
  systemPromptMode?: "replace" | "append";
  /** Whether the child inherits project context (AGENTS.md etc.). Default: delegate only. */
  inheritProjectContext?: boolean;
  /** Whether the child inherits skills. Default: false. */
  inheritSkills?: boolean;
  /** Default context for launches that omit context. */
  defaultContext?: "fresh" | "fork";
  runInBackground?: boolean;
  isolated?: boolean;
  /** Agent-level default run deadline. */
  timeoutMs?: number;
  /** Agent-level default hard per-tool deadline. */
  toolTimeoutMs?: number;
  /** Nested-delegation cap for this agent's children. */
  maxSubagentDepth?: number;
  /** Output file for this agent's result. */
  output?: string;
  /** inline (default) or file-only result reference. */
  outputMode?: "inline" | "file-only";
  /** Files to read before running. */
  defaultReads?: string[];
  /** Maintain progress.md during runs. */
  defaultProgress?: boolean;
  memory?: MemoryScope | AgentMemoryConfig;
  isDefault?: boolean;
  enabled?: boolean;
  source?: "builtin" | "project" | "global";
  /** Unknown frontmatter fields preserved for later phases. */
  extraFields?: Record<string, string>;
}

/** Agent record — tracks a running agent. */
export interface AgentRecord {
  id: string;
  type: AgentType;
  description: string;
  status: "queued" | "running" | "completed" | "aborted" | "stopped" | "error";
  result?: string;
  /** Private artifact holding the complete result when model-visible output is bounded. */
  resultArtifactPath?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Set when result consumed via get_result — suppresses notification. */
  resultConsumed?: boolean;
}

/** Extension config. */
export interface SubagentsConfig {
  maxConcurrent: number;
  enabled: boolean;
  types: Record<string, { enabled?: boolean }>;

  // ---- pi-subagents parity keys (optional; defaults follow the reference) ----
  /** Background execution for launches that omit run_in_background. Default: true (their asyncByDefault). */
  asyncByDefault?: boolean;
  /** Context for launches that omit context. "fresh" | "fork". */
  defaultSubagentContext?: "fresh" | "fork";
  /** Force depth-0 runs into background mode and bypass launch UI. Default: false. */
  forceTopLevelAsync?: boolean;
  /** Global default runtime deadline (ms). Replaces the 30-minute foreground backstop. */
  timeoutMs?: number;
  /** Optional hard per-tool-call deadline (ms). Precedence: call > agent frontmatter > this > env. */
  toolTimeoutMs?: number;
  /** Cap on simultaneously running children within durable multi-child runs. Default: 20. */
  globalConcurrencyLimit?: number;
  /** Cumulative child launches per parent session. Unset/0 = unlimited. */
  maxSubagentSpawnsPerSession?: number;
  /** Cumulative logical-child cap for one top-level run tree. Default: 64. */
  maxSubagentSpawnsPerRun?: number;
  /** Concurrently active top-level async runs per parent session. Unset/0 = unlimited. */
  maxActiveAsyncRunsPerSession?: number;
  /** Nested delegation depth cap. Default: 2. */
  maxSubagentDepth?: number;
  /** Parallel fanout caps. maxTasks default 8; concurrency default 4. */
  parallel?: { maxTasks?: number; concurrency?: number };
  /** Default output limits for child results. Default: 200KB / 5000 lines. */
  maxOutput?: { bytes?: number; lines?: number };
  /** Session directory for child sessions. `~/` expanded. */
  defaultSessionDir?: string;
  /** Show the persistent fleet panel. Default: true. */
  fleetView?: boolean;
  /** Fleet panel placement. Default: "belowEditor". */
  fleetViewPlacement?: "belowEditor" | "aboveEditor";
  /** Inline chat rendering for spawn_helper results. "rich" | "summary". Default: rich. */
  inlineToolDisplay?: "rich" | "summary";
  /** Main chat renderer density controls. */
  mainWindowRenderer?: { horizontalSpacing?: number; compactResultMaxLines?: number };
  /** How slow async result scans are logged. "all" | "activity" | "off". Default: all. */
  resultScanLogging?: "all" | "activity" | "off";
  /** Shortcut detaching the active foreground single run without terminating it. */
  foregroundDetachShortcut?: string;
  /** Keep get_helper_result registered but make direct calls non-blocking. Default: true. */
  waitTool?: boolean | { enabled?: boolean };
  /** Base directory for worktree-isolated runs. Default: OS temp. */
  worktreeBaseDir?: string;
  /** Hook run once per created worktree. */
  worktreeSetupHook?: string;
  /** Timeout for the worktree setup hook in ms. Default: 30000. */
  worktreeSetupHookTimeoutMs?: number;
  /** Missions store config. */
  missions?: {
    enabled?: boolean;
    directory?: string;
    globalIndex?: boolean;
    globalIndexDir?: string;
    retainTerminal?: number;
  };
  /** Scheduled runs config. */
  scheduledRuns?: { enabled?: boolean; maxPending?: number; storeRoot?: string };
  /** Authority policy for operational actions. */
  authorityPolicy?: {
    discardWorktree?: "confirm" | "auto";
    destructiveCleanup?: "confirm" | "auto";
    spawnBudgetGrant?: "confirm" | "auto";
    scheduleCreate?: "confirm" | "auto";
  };
}

/** Agent activity for widget display. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  tokens: string;
  responseText: string;
  session?: AgentSession;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}
