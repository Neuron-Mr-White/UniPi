/**
 * @pi-unipi/background-tasks — Config management
 *
 * Loads config from ~/.unipi/config/background-tasks.json (global) and
 * <workspace>/.unipi/config/background-tasks.json (override; workspace wins).
 * Follows the subagents.json layering pattern. The master `enabled` key
 * (default true) completely disables the module when false — no tools, no
 * commands, no hooks, no UI.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSettings, registerSettings, setSettings, settingsLayers } from "@pi-unipi/core";

/** Full config surface. Reference keys preserved; ours added where noted. */
export interface BackgroundTasksConfig {
  /** Master toggle. When false the module registers nothing at all. */
  enabled: boolean;
  /** Default notifyOnCompletion for tool-launched tasks. */
  notifyOnCompletion: boolean;
  /** Default triggerOnCompletion (follow-up wake) for bg_run tasks. */
  triggerOnCompletion: boolean;
  /** Default timeoutSeconds for shell tasks (0 = none). */
  defaultTimeoutSeconds: number;
  /** Max finished tasks retained in memory. */
  maxFinishedTasks: number;
  /** Output cap in bytes before a task is killed+failed (default 20 MiB). */
  maxOutputBytes: number;
  /** Delegate defaults. */
  delegate: {
    extensionMode: "isolated" | "ambient";
    autoDeliver: "never" | "when_small" | "always";
    maxTurns: number;
    maxToolCalls: number;
    timeoutSeconds: number;
  };
}

export const DEFAULT_CONFIG: BackgroundTasksConfig = {
  enabled: true,
  notifyOnCompletion: true,
  triggerOnCompletion: true,
  defaultTimeoutSeconds: 0,
  maxFinishedTasks: 30,
  maxOutputBytes: 20 * 1024 * 1024,
  delegate: {
    extensionMode: "isolated",
    autoDeliver: "when_small",
    maxTurns: 40,
    maxToolCalls: 120,
    timeoutSeconds: 900,
  },
};

function getGlobalConfigPath(): string {
  return join(homedir(), ".unipi", "config", "background-tasks.json");
}

function getWorkspaceConfigPath(cwd: string): string {
  return join(cwd, ".unipi", "config", "background-tasks.json");
}

function ensureDirExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function writeConfigAtomic(filePath: string, config: BackgroundTasksConfig): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

function loadConfigFromPath(filePath: string): Partial<BackgroundTasksConfig> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Partial<BackgroundTasksConfig>;
  } catch {
    return null;
  }
}

/** Shallow-merge partial layers over defaults (one level deep for nested blocks). */
function mergeLayers(base: BackgroundTasksConfig, ...partials: Array<Partial<BackgroundTasksConfig>>): BackgroundTasksConfig {
  const merged: BackgroundTasksConfig = { ...base };
  for (const partial of partials) {
    if (!partial) continue;
    for (const [key, value] of Object.entries(partial)) {
      if (value === undefined) continue;
      const typedKey = key as keyof BackgroundTasksConfig;
      const baseValue = merged[typedKey];
      if (
        typeof baseValue === "object" &&
        baseValue !== null &&
        !Array.isArray(baseValue) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        (merged as unknown as Record<string, unknown>)[typedKey] = { ...(baseValue as object), ...(value as object) };
      } else {
        (merged as unknown as Record<string, unknown>)[typedKey] = value;
      }
    }
  }
  return merged;
}

/**
 * Validate config values. Strict keys produce visible errors; unknown keys are
 * ignored (forward compatibility). Returns a list of problems; empty means valid.
 */
export function validateBackgroundTasksConfig(config: unknown): string[] {
  const problems: string[] = [];
  if (typeof config !== "object" || config === null) {
    return ["config must be an object"];
  }
  const c = config as Record<string, unknown>;

  if (c.enabled !== undefined && typeof c.enabled !== "boolean") {
    problems.push("enabled must be a boolean");
  }
  for (const key of ["notifyOnCompletion", "triggerOnCompletion"] as const) {
    if (c[key] !== undefined && typeof c[key] !== "boolean") {
      problems.push(`${key} must be a boolean`);
    }
  }
  if (c.defaultTimeoutSeconds !== undefined) {
    if (typeof c.defaultTimeoutSeconds !== "number" || !Number.isFinite(c.defaultTimeoutSeconds) || c.defaultTimeoutSeconds < 0) {
      problems.push("defaultTimeoutSeconds must be a non-negative number");
    }
  }
  if (c.maxFinishedTasks !== undefined) {
    if (typeof c.maxFinishedTasks !== "number" || !Number.isInteger(c.maxFinishedTasks) || c.maxFinishedTasks < 1) {
      problems.push("maxFinishedTasks must be a positive integer");
    }
  }
  if (c.maxOutputBytes !== undefined) {
    if (typeof c.maxOutputBytes !== "number" || !Number.isInteger(c.maxOutputBytes) || c.maxOutputBytes < 1024) {
      problems.push("maxOutputBytes must be an integer >= 1024");
    }
  }
  if (c.delegate !== undefined) {
    if (typeof c.delegate !== "object" || c.delegate === null) {
      problems.push("delegate must be an object");
    } else {
      const d = c.delegate as Record<string, unknown>;
      if (d.extensionMode !== undefined && d.extensionMode !== "isolated" && d.extensionMode !== "ambient") {
        problems.push('delegate.extensionMode must be "isolated" or "ambient"');
      }
      if (
        d.autoDeliver !== undefined &&
        d.autoDeliver !== "never" &&
        d.autoDeliver !== "when_small" &&
        d.autoDeliver !== "always"
      ) {
        problems.push('delegate.autoDeliver must be "never", "when_small", or "always"');
      }
      for (const key of ["maxTurns", "maxToolCalls"] as const) {
        if (d[key] !== undefined && (typeof d[key] !== "number" || !Number.isInteger(d[key]) || (d[key] as number) < 1)) {
          problems.push(`delegate.${key} must be a positive integer`);
        }
      }
      if (d.timeoutSeconds !== undefined && (typeof d.timeoutSeconds !== "number" || !Number.isFinite(d.timeoutSeconds) || (d.timeoutSeconds as number) <= 0)) {
        problems.push("delegate.timeoutSeconds must be a positive number");
      }
    }
  }
  return problems;
}

export interface LoadedBackgroundTasksConfig {
  config: BackgroundTasksConfig;
  /** Non-fatal problems encountered while loading individual layers. */
  warnings: string[];
}

/**
 * Load config with workspace-wins layering. Auto-generates the global file on
 * first run. Corrupt layers are skipped with a warning rather than crashing.
 */
// Registered with the unified settings hub — engine layering replaces the
// manual global/workspace merge. Legacy flat JSONs
// (~/.unipi/config/background-tasks.json + <cwd>/.unipi/config/background-tasks.json)
// are imported once into the engine layout on first load.
registerSettings({
  namespace: "background-tasks",
  label: "Background Tasks",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Tasks",
      fields: [
        { key: "enabled", type: "boolean", label: "Enabled", description: "Master toggle — off registers nothing" },
        { key: "notifyOnCompletion", type: "boolean", label: "Notify on completion" },
        { key: "triggerOnCompletion", type: "boolean", label: "Follow-up wake", description: "Terminal state wakes the agent" },
        { key: "defaultTimeoutSeconds", type: "number", label: "Timeout s", min: 0, zeroLabel: "∞ none" },
        { key: "maxFinishedTasks", type: "number", label: "Max finished kept", min: 1 },
      ],
    },
    {
      title: "Delegate",
      fields: [
        {
          key: "delegate.extensionMode",
          type: "enum",
          label: "Extension mode",
          options: [
            { value: "isolated", label: "isolated" },
            { value: "ambient", label: "ambient (weakens isolation)" },
          ],
        },
        {
          key: "delegate.autoDeliver",
          type: "enum",
          label: "Auto deliver",
          options: ["when_small", "always", "never"],
        },
        { key: "delegate.maxTurns", type: "number", label: "Max turns", min: 1 },
        { key: "delegate.maxToolCalls", type: "number", label: "Max tool calls", min: 1 },
        { key: "delegate.timeoutSeconds", type: "number", label: "Timeout s", min: 1 },
      ],
    },
  ],
});

/** One-time import of the legacy flat JSONs into the engine layout. */
function importLegacyBackgroundTasksConfig(cwd: string): string[] {
  const warnings: string[] = [];
  const layers = settingsLayers("background-tasks", cwd);
  if (!layers.global) {
    const path = getGlobalConfigPath();
    const raw = loadConfigFromPath(path);
    if (raw) setSettings("background-tasks", raw as Record<string, unknown>, "global", cwd);
    else if (existsSync(path)) warnings.push(`global config at ${path} is corrupt; using defaults`);
  }
  if (!layers.project) {
    const path = cwd ? getWorkspaceConfigPath(cwd) : null;
    if (path) {
      const raw = loadConfigFromPath(path);
      if (raw) setSettings("background-tasks", raw as Record<string, unknown>, "project", cwd);
      else if (existsSync(path)) warnings.push(`workspace config is corrupt; ignoring it`);
    }
  }
  return warnings;
}

export function loadBackgroundTasksConfig(cwd: string): LoadedBackgroundTasksConfig {
  const warnings: string[] = importLegacyBackgroundTasksConfig(cwd);

  const merged = getSettings("background-tasks", cwd) as unknown as Partial<BackgroundTasksConfig> & Record<string, unknown>;
  const problems = validateBackgroundTasksConfig(merged);
  if (problems.length > 0) {
    warnings.push(...problems.map((p) => `config problem: ${p}`));
  }
  // Sanitize: fall back to defaults for invalid values instead of crashing.
  const config: BackgroundTasksConfig = {
    ...merged,
    enabled: typeof merged.enabled === "boolean" ? merged.enabled : true,
    notifyOnCompletion:
      typeof merged.notifyOnCompletion === "boolean" ? merged.notifyOnCompletion : DEFAULT_CONFIG.notifyOnCompletion,
    triggerOnCompletion:
      typeof merged.triggerOnCompletion === "boolean" ? merged.triggerOnCompletion : DEFAULT_CONFIG.triggerOnCompletion,
    defaultTimeoutSeconds:
      typeof merged.defaultTimeoutSeconds === "number" && Number.isFinite(merged.defaultTimeoutSeconds) && merged.defaultTimeoutSeconds >= 0
        ? merged.defaultTimeoutSeconds
        : DEFAULT_CONFIG.defaultTimeoutSeconds,
    maxFinishedTasks:
      typeof merged.maxFinishedTasks === "number" && Number.isInteger(merged.maxFinishedTasks) && merged.maxFinishedTasks >= 1
        ? merged.maxFinishedTasks
        : DEFAULT_CONFIG.maxFinishedTasks,
    maxOutputBytes:
      typeof merged.maxOutputBytes === "number" && Number.isInteger(merged.maxOutputBytes) && merged.maxOutputBytes >= 1024
        ? merged.maxOutputBytes
        : DEFAULT_CONFIG.maxOutputBytes,
    delegate: {
      ...DEFAULT_CONFIG.delegate,
      ...merged.delegate,
      extensionMode: merged.delegate?.extensionMode === "ambient" ? "ambient" : "isolated",
      autoDeliver:
        merged.delegate?.autoDeliver === "never" || merged.delegate?.autoDeliver === "always"
          ? merged.delegate.autoDeliver
          : "when_small",
    },
  };
  return { config, warnings };
}

/** Persist settings to the engine global scope (settings overlay save path). */
export function saveGlobalBackgroundTasksConfig(config: BackgroundTasksConfig): void {
  setSettings("background-tasks", config as unknown as Record<string, unknown>, "global", process.cwd());
}
