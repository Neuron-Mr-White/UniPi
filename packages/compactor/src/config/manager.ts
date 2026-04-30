/**
 * Config manager — load, save, migrate compactor settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompactorConfig } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./schema.js";

export const COMPACTOR_CONFIG_PATH = join(homedir(), ".unipi", "config", "compactor", "config.json");

/** Return the per-project config path for a given project directory. */
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".unipi", "config", "compactor.json");
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/** Deep merge project overrides into global config. */
function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const baseVal = result[key];
    const overrideVal = override[key];
    if (
      overrideVal !== undefined &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      baseVal !== null
    ) {
      result[key] = deepMerge(baseVal as any, overrideVal as any);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result;
}

/**
 * Load compactor config from disk with defaults fallback.
 * Supports per-project overrides at <cwd>/.unipi/config/compactor.json.
 */
export function loadConfig(cwd?: string): CompactorConfig {
  const parsed = readJson(COMPACTOR_CONFIG_PATH);
  let config: CompactorConfig;
  if (!parsed || typeof parsed !== "object") {
    config = structuredClone(DEFAULT_COMPACTOR_CONFIG);
  } else {
    config = migrateConfig(parsed as Partial<CompactorConfig>);
  }

  // Apply per-project overrides if cwd is provided and project config exists
  if (cwd) {
    const projPath = projectConfigPath(cwd);
    const projOverride = readJson(projPath);
    if (projOverride && typeof projOverride === "object") {
      config = deepMerge(config, projOverride as Partial<CompactorConfig>);
    }
  }

  return config;
}

/**
 * Save config to disk with schema validation.
 * If perProject is true, saves to <cwd>/.unipi/config/compactor.json instead of global.
 */
export function saveConfig(config: CompactorConfig, opts?: { perProject?: boolean; cwd?: string }): { success: boolean; error?: string } {
  try {
    const targetPath = (opts?.perProject && opts?.cwd)
      ? projectConfigPath(opts.cwd)
      : COMPACTOR_CONFIG_PATH;
    const dir = dirname(targetPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Migrate partial config to full schema, filling missing keys from defaults.
 */
export function migrateConfig(partial: Partial<CompactorConfig>): CompactorConfig {
  const defaults = structuredClone(DEFAULT_COMPACTOR_CONFIG);

  function mergeStrategy<K extends keyof CompactorConfig>(
    key: K,
    defaultVal: CompactorConfig[K],
    partialVal: CompactorConfig[K] | undefined,
  ): CompactorConfig[K] {
    if (!partialVal || typeof partialVal !== "object") return defaultVal;
    return { ...(defaultVal as any), ...(partialVal as any) };
  }

  return {
    sessionGoals: mergeStrategy("sessionGoals", defaults.sessionGoals, partial.sessionGoals),
    filesAndChanges: mergeStrategy("filesAndChanges", defaults.filesAndChanges, partial.filesAndChanges),
    commits: mergeStrategy("commits", defaults.commits, partial.commits),
    outstandingContext: mergeStrategy("outstandingContext", defaults.outstandingContext, partial.outstandingContext),
    userPreferences: mergeStrategy("userPreferences", defaults.userPreferences, partial.userPreferences),
    briefTranscript: mergeStrategy("briefTranscript", defaults.briefTranscript, partial.briefTranscript),
    sessionContinuity: mergeStrategy("sessionContinuity", defaults.sessionContinuity, partial.sessionContinuity),
    fts5Index: mergeStrategy("fts5Index", defaults.fts5Index, partial.fts5Index),
    sandboxExecution: mergeStrategy("sandboxExecution", defaults.sandboxExecution, partial.sandboxExecution),
    toolDisplay: mergeStrategy("toolDisplay", defaults.toolDisplay, partial.toolDisplay),
    pipeline: mergeStrategy("pipeline", defaults.pipeline, (partial as any).pipeline) as any,
    overrideDefaultCompaction: partial.overrideDefaultCompaction ?? defaults.overrideDefaultCompaction,
    debug: partial.debug ?? defaults.debug,
    showTruncationHints: partial.showTruncationHints ?? defaults.showTruncationHints,
  };
}

/**
 * Scaffold config file on first run.
 */
export function scaffoldConfig(): void {
  try {
    const dir = dirname(COMPACTOR_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(COMPACTOR_CONFIG_PATH)) {
      writeFileSync(COMPACTOR_CONFIG_PATH, `${JSON.stringify(DEFAULT_COMPACTOR_CONFIG, null, 2)}\n`);
    }
  } catch {
    // best-effort
  }
}
