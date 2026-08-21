/**
 * @pi-unipi/subagents — Child safety, depth guard, context resolution
 *
 * Ported from pi-subagents subagent-prompt-runtime.ts boundary instructions
 * and context-mode.ts. Tool references adapted to OUR names (spawn_helper).
 * In-process foreground children are always "fresh" context; explicit fork
 * resolves here to a visible error pointing at the async path (Phase 3 adds
 * the process-based fork runner).
 */

import type { AgentConfig, SubagentsConfig } from "./types.js";

export type ContextMode = "fresh" | "fork";

export function isContextMode(value: unknown): value is ContextMode {
  return value === "fresh" || value === "fork";
}

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent, not the parent orchestrator.",
  "The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
  "Ignore prior parent-only orchestration instructions in inherited conversation history.",
  "Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
  "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
  "You are a child subagent with explicit fanout responsibility for this assigned task.",
  "The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
  "You may use the `spawn_helper` tool only for the fanout work explicitly requested in this task.",
  "Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
  "The maxSubagentDepth cap still applies and may block further fanout.",
  "If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

/** Whether the resolved agent's tools opt the child into fanout (spawn_helper). */
export function isFanoutChild(agent: AgentConfig | undefined): boolean {
  return !!agent?.builtinToolNames?.includes("spawn_helper");
}

/** Prepend boundary instructions to a child prompt (fanout children get the fanout variant). */
export function withChildBoundaryInstructions(prompt: string, agent: AgentConfig | undefined): string {
  const boundary = isFanoutChild(agent) ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
  const text = prompt.trim();
  return text ? `${boundary}\n\n${text}` : boundary;
}

// ============================================================================
// Depth guard
// ============================================================================

export const MAX_SUBAGENT_DEPTH_ENV = "UNIPI_SUBAGENT_MAX_DEPTH";
export const CURRENT_SUBAGENT_DEPTH_ENV = "UNIPI_SUBAGENT_DEPTH";

/**
 * Resolve the effective depth cap. An inherited stricter cap cannot be
 * relaxed; per-agent caps can only tighten. Reference semantics.
 */
export function resolveMaxSubagentDepth(
  agent: AgentConfig | undefined,
  config: SubagentsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const inheritedRaw = env[MAX_SUBAGENT_DEPTH_ENV];
  const inherited = inheritedRaw !== undefined && inheritedRaw.trim() !== "" ? Number(inheritedRaw) : undefined;
  if (inherited !== undefined && Number.isInteger(inherited) && inherited >= 0) {
    const agentCap = agent?.maxSubagentDepth;
    if (agentCap !== undefined && Number.isInteger(agentCap) && agentCap >= 0 && agentCap < inherited) {
      return agentCap;
    }
    return inherited;
  }
  const configured = config?.maxSubagentDepth;
  if (configured !== undefined && Number.isInteger(configured) && configured > 0) return configured;
  return 2; // reference default
}

/**
 * Environment for a child process/session: depth counters increment so a
 * child's own spawns hit the cap.
 */
export function childDepthEnv(env: NodeJS.ProcessEnv, maxDepth: number): Record<string, string> {
  const currentRaw = env[CURRENT_SUBAGENT_DEPTH_ENV];
  const current = currentRaw !== undefined && currentRaw.trim() !== "" ? Number(currentRaw) : 0;
  return {
    [MAX_SUBAGENT_DEPTH_ENV]: String(maxDepth),
    [CURRENT_SUBAGENT_DEPTH_ENV]: String(Number.isInteger(current) && current >= 0 ? current + 1 : 1),
  };
}

/** Whether spawning is blocked by the depth guard for this environment. */
export function depthExceeded(env: NodeJS.ProcessEnv, maxDepth: number): boolean {
  const currentRaw = env[CURRENT_SUBAGENT_DEPTH_ENV];
  if (currentRaw === undefined || currentRaw.trim() === "") return false;
  const current = Number(currentRaw);
  return Number.isInteger(current) && current >= maxDepth;
}

// ============================================================================
// Context resolution (in-process foreground)
// ============================================================================

export class ContextUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextUnavailableError";
  }
}

/**
 * Resolve launch context: explicit call value > config defaultSubagentContext >
 * agent defaultContext > "fresh". Explicit fork on the IN-PROCESS path fails
 * fast with a pointer to the async path (reference behavior: explicit fork
 * never silently downgrades).
 */
export function resolveContext(
  callContext: string | undefined,
  agent: AgentConfig | undefined,
  config: SubagentsConfig | undefined,
): ContextMode {
  if (callContext === "fresh" || callContext === "fork") return callContext;
  if (callContext === "profile") {
    return agent?.defaultContext ?? "fresh";
  }
  const configDefault = config?.defaultSubagentContext;
  if (configDefault === "fresh" || configDefault === "fork") return configDefault;
  return agent?.defaultContext ?? "fresh";
}

/**
 * In-process foreground runs are always fresh-context. An explicit fork
 * request rejects with guidance (Phase 3's process runner provides fork).
 */
export function assertForegroundContextSupported(mode: ContextMode, async: boolean): void {
  if (mode === "fork" && !async) {
    throw new ContextUnavailableError(
      'context: "fork" requires background execution (run_in_background: true); the in-process foreground path is fresh-context only. Re-run with run_in_background, or use context: "fresh".',
    );
  }
}
