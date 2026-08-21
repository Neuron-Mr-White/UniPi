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
  /** Fusion defaults. */
  fusion: {
    /** Five-slot model selections ('' = $current). */
    candidates: [string, string, string];
    evaluator: string;
    merger: string;
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
  fusion: {
    candidates: ["", "", ""],
    evaluator: "",
    merger: "",
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
  if (c.fusion !== undefined) {
    if (typeof c.fusion !== "object" || c.fusion === null) {
      problems.push("fusion must be an object");
    } else {
      const f = c.fusion as Record<string, unknown>;
      for (const key of ["candidates", "evaluator", "merger"] as const) {
        const value = f[key];
        if (value === undefined) continue;
        if (key === "candidates") {
          if (
            !Array.isArray(value) ||
            value.length !== 3 ||
            value.some((v) => typeof v !== "string")
          ) {
            problems.push("fusion.candidates must be an array of exactly 3 strings");
          }
        } else if (typeof value !== "string") {
          problems.push(`fusion.${key} must be a string`);
        }
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
export function loadBackgroundTasksConfig(cwd: string): LoadedBackgroundTasksConfig {
  const warnings: string[] = [];
  const globalPath = getGlobalConfigPath();

  if (!existsSync(globalPath)) {
    try {
      ensureDirExists(join(globalPath, ".."));
      writeConfigAtomic(globalPath, DEFAULT_CONFIG);
    } catch {
      warnings.push(`could not create global config at ${globalPath}`);
    }
  }

  const globalLayer = loadConfigFromPath(globalPath);
  if (globalLayer === null && existsSync(globalPath)) {
    warnings.push(`global config at ${globalPath} is corrupt; using defaults`);
  }
  const workspaceLayer = cwd ? loadConfigFromPath(getWorkspaceConfigPath(cwd)) : null;
  if (workspaceLayer === null && cwd && existsSync(getWorkspaceConfigPath(cwd))) {
    warnings.push(`workspace config is corrupt; ignoring it`);
  }

  const merged = mergeLayers(DEFAULT_CONFIG, globalLayer ?? {}, workspaceLayer ?? {});
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
    fusion: {
      candidates:
        Array.isArray(merged.fusion?.candidates) && merged.fusion.candidates.length === 3
          ? ([...merged.fusion.candidates] as [string, string, string])
          : DEFAULT_CONFIG.fusion.candidates,
      evaluator: typeof merged.fusion?.evaluator === "string" ? merged.fusion.evaluator : "",
      merger: typeof merged.fusion?.merger === "string" ? merged.fusion.merger : "",
    },
  };
  return { config, warnings };
}

/** Persist settings back to the global config file (settings overlay save path). */
export function saveGlobalBackgroundTasksConfig(config: BackgroundTasksConfig): void {
  const globalPath = getGlobalConfigPath();
  ensureDirExists(join(globalPath, ".."));
  writeConfigAtomic(globalPath, config);
}
