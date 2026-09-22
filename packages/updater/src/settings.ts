/**
 * @pi-unipi/updater — Configuration management
 *
 * Loads, saves, and validates updater config from ~/.unipi/config/updater/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { UPDATER_DIRS, getSettings, registerSettings, setSettings } from "@pi-unipi/core";
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

// Registered with the unified settings hub — canonical path already matched.
registerSettings({
  namespace: "updater",
  label: "Updater",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Updates",
      fields: [
        {
          key: "checkIntervalMs",
          type: "enum",
          label: "Check interval",
          options: [
            { value: "1800000", label: "30 min" },
            { value: "3600000", label: "1 hour" },
            { value: "21600000", label: "6 hours" },
            { value: "86400000", label: "daily" },
          ],
          description: "How often to check npm for updates",
        },
        {
          key: "autoUpdate",
          type: "enum",
          label: "Auto update",
          options: ["disabled", "notify", "auto"],
        },
      ],
    },
  ],
});

/** Load config (engine-layered), returning defaults if missing or invalid */
export function loadConfig(): UpdaterConfig {
  try {
    const parsed = getSettings("updater", process.cwd()) as Partial<UpdaterConfig>;
    return mergeWithDefaults(parsed);
  } catch (_err) {
    // Config load failure — using defaults silently.
  }
  return { ...DEFAULT_CONFIG };
}

/** Save config to disk, creating directory if needed */
export function saveConfig(config: UpdaterConfig): void {
  setSettings("updater", config as unknown as Record<string, unknown>, "global", process.cwd());
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
