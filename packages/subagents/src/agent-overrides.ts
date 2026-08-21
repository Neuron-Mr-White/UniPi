/**
 * @pi-unipi/subagents — Builtin agent overrides + defaults
 *
 * Ported from pi-subagents applyBuiltinOverrides/applySubagentDefaults
 * (src/agents/agents.ts). Semantics identical; the source of settings is OUR
 * subagents.json `subagents` object (user: ~/.unipi/config/subagents.json;
 * project: <ws>/.unipi/config/subagents.json) instead of pi settings files.
 *
 * Our existing enablement rule is preserved: merged JSON types[name].enabled
 * !== false AND resolved agent frontmatter enabled !== false. disableBuiltins
 * (reference parity) disables ALL builtin agents (code + file) while custom
 * user/project agents keep working.
 */

import type { AgentConfig } from "./types.js";

export interface BuiltinAgentOverrideConfig {
  description?: string;
  outputMode?: "inline" | "file-only";
  model?: string | false;
  fallbackModels?: string[] | false;
  thinking?: string | false;
  systemPromptMode?: "replace" | "append";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork" | false;
  disabled?: boolean;
  systemPrompt?: string;
  skills?: string[] | false;
  tools?: string[] | false | "inherit";
  extensions?: string[] | false;
  toolBudget?: { soft?: number; hard: number; block?: string[] | "*" } | false;
  maxSubagentDepth?: number;
}

/** Settings block inside our subagents.json: { "subagents": { ... } }. */
export interface SubagentSettings {
  overrides: Record<string, BuiltinAgentOverrideConfig>;
  defaultModel?: string;
  defaultThinking?: string | false;
  defaultExtensions?: string[];
  disableBuiltins?: boolean;
  disableThinking?: boolean;
}

export const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

/** Parse the settings block from a parsed subagents.json (missing → empty). */
export function parseSubagentSettings(raw: unknown): SubagentSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_SUBAGENT_SETTINGS;
  const obj = raw as Record<string, unknown>;
  const overrides: Record<string, BuiltinAgentOverrideConfig> = {};
  if (obj.overrides && typeof obj.overrides === "object" && !Array.isArray(obj.overrides)) {
    for (const [name, value] of Object.entries(obj.overrides as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        overrides[name] = value as BuiltinAgentOverrideConfig;
      }
    }
  }
  const settings: SubagentSettings = { overrides };
  if (typeof obj.defaultModel === "string" && obj.defaultModel.trim()) {
    settings.defaultModel = obj.defaultModel.trim();
  }
  if (obj.defaultThinking === false || typeof obj.defaultThinking === "string") {
    settings.defaultThinking = obj.defaultThinking;
  }
  if (Array.isArray(obj.defaultExtensions)) {
    settings.defaultExtensions = obj.defaultExtensions.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
  }
  if (obj.disableBuiltins === true) settings.disableBuiltins = true;
  if (obj.disableThinking === true) settings.disableThinking = true;
  return settings;
}

function applyToolsOverride(target: AgentConfig, toolsOverride: string[] | false | "inherit"): void {
  if (toolsOverride === "inherit") {
    delete target.builtinToolNames;
    return;
  }
  target.builtinToolNames = toolsOverride === false ? [] : [...toolsOverride];
}

/** Apply a single override to a builtin agent (reference applyBuiltinOverride). */
export function applyBuiltinOverride(
  agent: AgentConfig,
  override: BuiltinAgentOverrideConfig,
): AgentConfig {
  const next: AgentConfig = { ...agent };
  if (override.description !== undefined) next.description = override.description;
  if (override.outputMode !== undefined) next.outputMode = override.outputMode;
  if (override.model !== undefined) next.model = override.model === false ? undefined : override.model;
  if (override.fallbackModels !== undefined) {
    next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
  }
  if (override.thinking !== undefined) next.thinking = override.thinking;
  if (override.systemPromptMode !== undefined) {
    next.promptMode = override.systemPromptMode;
    next.systemPromptMode = override.systemPromptMode;
  }
  if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
  if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
  if (override.defaultContext !== undefined) {
    next.defaultContext = override.defaultContext === false ? undefined : override.defaultContext;
  }
  if (override.systemPrompt !== undefined && override.systemPrompt.trim()) {
    next.systemPrompt = override.systemPrompt;
  }
  if (override.skills !== undefined) {
    next.skills = override.skills === false ? false : [...override.skills];
  }
  if (override.tools !== undefined) applyToolsOverride(next, override.tools);
  if (override.extensions !== undefined) {
    next.extensions = override.extensions === false ? false : [...override.extensions];
  }
  if (override.toolBudget !== undefined) {
    // Stored for Phase 2 budget resolution.
    (next as AgentConfig & { toolBudget?: unknown }).toolBudget =
      override.toolBudget === false ? undefined : override.toolBudget;
  }
  if (override.maxSubagentDepth !== undefined) next.maxSubagentDepth = override.maxSubagentDepth;
  if (override.disabled === true) next.enabled = false;
  else if (override.disabled === false) next.enabled = true;
  return next;
}

/** Apply defaultModel/defaultThinking/defaultExtensions to a loaded agent list. */
export function applySubagentDefaults(
  agents: AgentConfig[],
  settings: SubagentSettings,
): AgentConfig[] {
  return agents.map((agent) => {
    let next = agent;
    if (settings.defaultModel && !agent.model) {
      next = { ...next, model: settings.defaultModel };
    }
    if (settings.defaultThinking !== undefined && agent.thinking === undefined) {
      next = { ...next, thinking: settings.defaultThinking };
    }
    if (settings.defaultExtensions?.length && agent.extensions === true) {
      next = { ...next, extensions: [...settings.defaultExtensions] };
    }
    return next;
  });
}

/**
 * Apply builtin overrides to a builtin agent list. Project settings win over
 * user settings per-field; disableBuiltins disables every builtin agent when
 * active; disableThinking clears thinking from builtins without an explicit
 * override (reference semantics).
 */
export function applyBuiltinOverrides(
  builtinAgents: AgentConfig[],
  userSettings: SubagentSettings,
  projectSettings: SubagentSettings,
): AgentConfig[] {
  const projectBulkDisabled = projectSettings.disableBuiltins === true;
  const userBulkDisabled = !projectBulkDisabled && userSettings.disableBuiltins === true;
  const disableThinking = projectSettings.disableThinking ?? userSettings.disableThinking ?? false;

  return builtinAgents.map((agent) => {
    const projectOverride = projectSettings.overrides[agent.name];
    if (projectOverride) {
      return withThinkingPolicy(applyBuiltinOverride(agent, projectOverride), projectOverride.thinking !== undefined);
    }
    const userOverride = userSettings.overrides[agent.name];
    if (userOverride) {
      return withThinkingPolicy(applyBuiltinOverride(agent, userOverride), userOverride.thinking !== undefined);
    }
    if (projectBulkDisabled || userBulkDisabled) {
      return withThinkingPolicy({ ...agent, enabled: false }, false);
    }
    return withThinkingPolicy(agent, false);
  });

  function withThinkingPolicy(agent: AgentConfig, hasExplicitThinkingOverride: boolean): AgentConfig {
    if (!disableThinking || hasExplicitThinkingOverride) return agent;
    if (agent.thinking === undefined) return agent;
    return { ...agent, thinking: undefined };
  }
}
