/**
 * @pi-unipi/updater — Configuration management
 *
 * Loads, saves, and validates updater config from ~/.unipi/config/updater/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { UPDATER_DIRS } from "@pi-unipi/core";
import type { UpdaterConfig } from "../types.js";

/** Default configuration — 1 hour check interval, notify mode */
export const DEFAULT_CONFIG: UpdaterConfig = {
  checkIntervalMs: 3600000, // 1 hour
  autoUpdate: "notify",
};

/** Valid check intervals in milliseconds */
const VALID_INTERVALS: Record<string, number> = {
  "30min": 1800000,
  "1h": 3600000,
  "6h": 21600000,
  "1d": 86400000,
};

/** Valid auto-update modes */
const VALID_MODES: UpdaterConfig["autoUpdate"][] = ["disabled", "notify", "auto"];

/** Resolve config path */
function resolveConfigPath(): string {
  const base = UPDATER_DIRS.CONFIG.replace("~", homedir());
  return join(base, "config.json");
}

/** Load config from disk, returning defaults if missing or invalid */
export function loadConfig(): UpdaterConfig {
  const configPath = resolveConfigPath();
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<UpdaterConfig>;
      return mergeWithDefaults(parsed);
    }
  } catch (_err) {
    // Config load failure — using defaults silently.
  }
  return { ...DEFAULT_CONFIG };
}

/** Save config to disk, creating directory if needed */
export function saveConfig(config: UpdaterConfig): void {
  const configPath = resolveConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Validate config, returning list of error messages */
export function validateConfig(config: UpdaterConfig): string[] {
  const errors: string[] = [];

  if (!VALID_MODES.includes(config.autoUpdate)) {
    errors.push(`autoUpdate must be one of: ${VALID_MODES.join(", ")}`);
  }

  if (config.checkIntervalMs < 60000) {
    errors.push("checkIntervalMs must be at least 60000 (1 minute)");
  }

  return errors;
}

/** Get human-readable label for an interval */
export function getIntervalLabel(ms: number): string {
  for (const [label, value] of Object.entries(VALID_INTERVALS)) {
    if (value === ms) return label;
  }
  return `${Math.round(ms / 60000)}min`;
}

/** Get all valid intervals as { label, ms } pairs */
export function getIntervalOptions(): Array<{ label: string; ms: number }> {
  return Object.entries(VALID_INTERVALS).map(([label, ms]) => ({ label, ms }));
}

/** Get all valid auto-update modes */
export function getAutoUpdateOptions(): UpdaterConfig["autoUpdate"][] {
  return [...VALID_MODES];
}

/** Merge loaded config with defaults to ensure all fields exist */
function mergeWithDefaults(loaded: Partial<UpdaterConfig>): UpdaterConfig {
  return {
    checkIntervalMs: loaded.checkIntervalMs ?? DEFAULT_CONFIG.checkIntervalMs,
    autoUpdate: loaded.autoUpdate ?? DEFAULT_CONFIG.autoUpdate,
  };
}
