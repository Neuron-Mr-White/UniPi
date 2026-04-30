/**
 * Config manager — load, save, migrate compactor settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CompactorConfig } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./schema.js";

export const COMPACTOR_CONFIG_PATH = join(homedir(), ".unipi", "config", "compactor", "config.json");

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

/**
 * Load compactor config from disk with defaults fallback.
 */
export function loadConfig(): CompactorConfig {
  const parsed = readJson(COMPACTOR_CONFIG_PATH);
  if (!parsed || typeof parsed !== "object") return structuredClone(DEFAULT_COMPACTOR_CONFIG);
  return migrateConfig(parsed as Partial<CompactorConfig>);
}

/**
 * Save config to disk with schema validation.
 */
export function saveConfig(config: CompactorConfig): { success: boolean; error?: string } {
  try {
    const dir = dirname(COMPACTOR_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(COMPACTOR_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
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
    pipeline: partial.pipeline ? { ...defaults.pipeline, ...partial.pipeline } : defaults.pipeline,
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
