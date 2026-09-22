/**
 * Config manager — load, save, migrate compactor settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";
import type { CompactorConfig } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./schema.js";

// Registered with the unified settings hub. Canonical paths match this
// module's existing layout exactly (global ~/.unipi/config/compactor/config.json,
// project .unipi/config/compactor/config.json after the v3 migration move).
registerSettings({
  namespace: "compactor",
  label: "Compactor",
  defaults: DEFAULT_COMPACTOR_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Strategies",
      description: "Per-strategy modes live here; detailed tuning in /unipi:compactor-settings",
      fields: [
        { key: "sessionGoals.enabled", type: "boolean", label: "Session goals" },
        { key: "filesAndChanges.enabled", type: "boolean", label: "Files and changes" },
        { key: "commits.enabled", type: "boolean", label: "Commits" },
        { key: "outstandingContext.enabled", type: "boolean", label: "Outstanding context" },
        { key: "userPreferences.enabled", type: "boolean", label: "User preferences" },
        { key: "briefTranscript.enabled", type: "boolean", label: "Brief transcript" },
        { key: "sessionContinuity.enabled", type: "boolean", label: "Session continuity" },
        { key: "sandboxExecution.enabled", type: "boolean", label: "Sandbox execution" },
      ],
    },
  ],
});

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
      overrideVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      baseVal !== null
    ) {
      (result as any)[key] = deepMerge(baseVal as any, overrideVal as any);
    } else if (overrideVal !== undefined) {
      (result as any)[key] = overrideVal;
    }
  }
  return result;
}

/**
 * Load compactor config from disk with defaults fallback.
 * Supports per-project overrides at <cwd>/.unipi/config/compactor.json.
 */
export function loadConfig(cwd?: string): CompactorConfig {
  const raw = getSettings("compactor", cwd ?? process.cwd());
  let config: CompactorConfig;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    config = structuredClone(DEFAULT_COMPACTOR_CONFIG);
  } else {
    config = migrateConfig(raw as Partial<CompactorConfig>);
  }


  return config;
}

/**
 * Save config to disk with schema validation.
 * If perProject is true, saves to <cwd>/.unipi/config/compactor.json instead of global.
 */
export function saveConfig(config: CompactorConfig, opts?: { perProject?: boolean; cwd?: string }): { success: boolean; error?: string } {
  try {
    setSettings(
      "compactor",
      config as unknown as Record<string, unknown>,
      opts?.perProject ? "project" : "global",
      opts?.cwd ?? process.cwd(),
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Migrate partial config to full schema, filling missing keys from defaults.
 * Uses deepMerge so nested strategy objects merge recursively.
 */
export function migrateConfig(partial: Partial<CompactorConfig>): CompactorConfig {
  const defaults = structuredClone(DEFAULT_COMPACTOR_CONFIG);
  return deepMerge(defaults, partial);
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
