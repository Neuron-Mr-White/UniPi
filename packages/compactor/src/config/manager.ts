/**
 * Config manager — load, save, migrate compactor settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSettings, registerSettings, setSettings, type SettingsField } from "@pi-unipi/core";
import type { CompactorConfig } from "../types.js";
import { DEFAULT_COMPACTOR_CONFIG } from "./schema.js";

// Registered with the unified settings hub. Canonical paths match this
// module's existing layout exactly (global ~/.unipi/config/compactor/config.json,
// project .unipi/config/compactor/config.json after the v3 migration move).
//
// Absorbs the deleted legacy settings overlay: per-strategy modes,
// the % auto-compaction trigger, pipeline toggles, and preset actions.
const STRATEGY_MODES: ReadonlyArray<SettingsField> = [
  { key: "sessionGoals.mode", type: "enum", label: "Session goals mode", options: ["full", "brief", "off"] },
  { key: "filesAndChanges.mode", type: "enum", label: "Files & changes mode", options: ["all", "modified-only", "off"] },
  { key: "commits.mode", type: "enum", label: "Commits mode", options: ["full", "brief", "off"] },
  { key: "outstandingContext.mode", type: "enum", label: "Outstanding context mode", options: ["full", "critical-only", "off"] },
  { key: "userPreferences.mode", type: "enum", label: "User preferences mode", options: ["all", "recent-only", "off"] },
  { key: "briefTranscript.mode", type: "enum", label: "Brief transcript mode", options: ["full", "compact", "minimal", "off"] },
  { key: "sessionContinuity.mode", type: "enum", label: "Session continuity mode", options: ["full", "off"] },
  { key: "sandboxExecution.mode", type: "enum", label: "Sandbox execution mode", options: ["all", "off"] },
];

registerSettings({
  namespace: "compactor",
  label: "Compactor",
  defaults: DEFAULT_COMPACTOR_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Strategies",
      description: "What the lossless summarizer extracts",
      fields: [
        { key: "sessionGoals.enabled", type: "boolean", label: "Session goals" },
        { key: "filesAndChanges.enabled", type: "boolean", label: "Files and changes" },
        { key: "commits.enabled", type: "boolean", label: "Commits" },
        { key: "outstandingContext.enabled", type: "boolean", label: "Outstanding context" },
        { key: "userPreferences.enabled", type: "boolean", label: "User preferences" },
        { key: "briefTranscript.enabled", type: "boolean", label: "Brief transcript" },
        { key: "sessionContinuity.enabled", type: "boolean", label: "Session continuity" },
        { key: "sandboxExecution.enabled", type: "boolean", label: "Sandbox execution" },
        ...STRATEGY_MODES,
      ],
    },
    {
      title: "Auto",
      description: "UniPi-managed %-of-context auto-compaction",
      fields: [
        { key: "autoCompaction.enabled", type: "boolean", label: "Percentage trigger", description: "Compact when Pi reports context usage at or above the threshold" },
        { key: "autoCompaction.thresholdPercent", type: "number", label: "Threshold %", min: 50, max: 99 },
        { key: "autoCompaction.cooldownMs", type: "number", label: "Cooldown ms", min: 0, zeroLabel: "0s none", description: "Minimum delay between auto-compaction attempts" },
        { key: "autoCompaction.repeatMinGrowthTokens", type: "number", label: "Repeat growth tokens", min: 0, zeroLabel: "off", description: "New tokens required to re-compact above threshold" },
        { key: "autoCompaction.notify", type: "boolean", label: "Notifications", description: "Notify when auto-compaction triggers or fails" },
      ],
    },
    {
      title: "Pipeline",
      fields: [
        { key: "pipeline.autoInjection", type: "boolean", label: "Auto injection", description: "Inject behavioral state after compaction" },
        { key: "smartKeepTail", type: "boolean", label: "Smart keep tail", description: "Grow keep:N tail to ≥5k tokens when it would be tiny" },
        { key: "continueAfterThresholdCompact", type: "boolean", label: "Auto-continue", description: "Resume the agent after threshold/overflow compaction" },
        { key: "debug", type: "boolean", label: "Debug output", description: "Write compaction diagnostics to /tmp/compactor-debug.json" },
      ],
    },
    {
      title: "Presets",
      description: "One-key bundles of strategy + auto settings",
      fields: [
        { key: "preset.precise", type: "action", label: "Apply preset: precise", description: "Maximum fidelity — everything on, full modes", command: "unipi:compact-apply-precise" },
        { key: "preset.balanced", type: "action", label: "Apply preset: balanced", description: "Default mix", command: "unipi:compact-apply-balanced" },
        { key: "preset.thorough", type: "action", label: "Apply preset: thorough", description: "Deep extraction, heavier output", command: "unipi:compact-apply-thorough" },
        { key: "preset.lean", type: "action", label: "Apply preset: lean", description: "Minimal footprint", command: "unipi:compact-apply-lean" },
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
