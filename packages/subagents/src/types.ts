/**
 * @pi-unipi/subagents — Type definitions
 */

import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";

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

/** Unified agent configuration. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  disallowedTools?: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  systemPrompt: string;
  promptMode: "replace" | "append";
  inheritContext?: boolean;
  runInBackground?: boolean;
  isolated?: boolean;
  memory?: MemoryScope;
  isDefault?: boolean;
  enabled?: boolean;
  source?: "builtin" | "project" | "global";
}

/** Agent record — tracks a running agent. */
export interface AgentRecord {
  id: string;
  type: AgentType;
  description: string;
  status: "queued" | "running" | "completed" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Set when result consumed via get_result — suppresses notification. */
  resultConsumed?: boolean;
  /** Files locked by this agent. */
  lockedFiles: Set<string>;
}

/** File lock entry. */
export interface FileLockEntry {
  agentId: string;
  filePath: string;
  promise: Promise<void>;
  release: () => void;
}

/** Extension config. */
export interface SubagentsConfig {
  maxConcurrent: number;
  enabled: boolean;
  types: Record<string, { enabled?: boolean }>;
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
