/**
 * @pi-unipi/info-screen — Config system
 *
 * Reads/writes info-screen settings in ~/.pi/agent/settings.json
 * under the "unipi.info" key.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InfoScreenSettings, GroupSettings } from "./types.js";
import { DEFAULT_SETTINGS } from "./types.js";

/** Settings path */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Settings key within settings.json */
const SETTINGS_KEY = "unipi";

/** Cached settings */
let cachedSettings: InfoScreenSettings | null = null;

/**
 * Check if value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the full settings file.
 */
function readSettingsFile(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Write the full settings file.
 */
function writeSettingsFile(data: Record<string, unknown>): void {
  const dir = require("node:path").dirname(SETTINGS_PATH);
  if (!existsSync(dir)) {
    require("node:fs").mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Get info-screen settings from settings.json.
 */
export function getInfoSettings(): InfoScreenSettings {
  if (cachedSettings) return cachedSettings;

  const settings = readSettingsFile();
  const unipi = settings[SETTINGS_KEY];

  if (!isRecord(unipi) || !isRecord(unipi.info)) {
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  const info = unipi.info as Record<string, unknown>;

  cachedSettings = {
    showOnBoot: typeof info.showOnBoot === "boolean" ? info.showOnBoot : DEFAULT_SETTINGS.showOnBoot,
    bootTimeoutMs: typeof info.bootTimeoutMs === "number" ? info.bootTimeoutMs : DEFAULT_SETTINGS.bootTimeoutMs,
    groups: isRecord(info.groups) ? parseGroupSettings(info.groups) : {},
  };

  return cachedSettings;
}

/**
 * Parse group settings from raw object.
 */
function parseGroupSettings(raw: Record<string, unknown>): Record<string, GroupSettings> {
  const result: Record<string, GroupSettings> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;

    result[key] = {
      show: typeof value.show === "boolean" ? value.show : true,
      stats: isRecord(value.stats) ? parseStatSettings(value.stats) : undefined,
    };
  }

  return result;
}

/**
 * Parse stat settings from raw object.
 */
function parseStatSettings(raw: Record<string, unknown>): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Save info-screen settings to settings.json.
 */
export function saveInfoSettings(settings: InfoScreenSettings): void {
  const file = readSettingsFile();

  if (!isRecord(file[SETTINGS_KEY])) {
    file[SETTINGS_KEY] = {};
  }

  (file[SETTINGS_KEY] as Record<string, unknown>).info = {
    showOnBoot: settings.showOnBoot,
    bootTimeoutMs: settings.bootTimeoutMs,
    groups: settings.groups,
  };

  writeSettingsFile(file);
  cachedSettings = settings;
}

/**
 * Get settings for a specific group.
 */
export function getGroupSettings(groupId: string): GroupSettings {
  const settings = getInfoSettings();
  return settings.groups[groupId] ?? { show: true };
}

/**
 * Update settings for a specific group.
 */
export function setGroupSettings(groupId: string, groupSettings: GroupSettings): void {
  const settings = getInfoSettings();
  settings.groups[groupId] = groupSettings;
  saveInfoSettings(settings);
}

/**
 * Check if a group is enabled.
 */
export function isGroupEnabled(groupId: string): boolean {
  const settings = getInfoSettings();
  if (!(groupId in settings.groups)) return true; // Default to enabled
  return settings.groups[groupId].show;
}

/**
 * Check if a stat within a group is enabled.
 */
export function isStatEnabled(groupId: string, statId: string): boolean {
  const groupSettings = getGroupSettings(groupId);
  if (!groupSettings.stats) return true; // Default to enabled
  if (!(statId in groupSettings.stats)) return true;
  return groupSettings.stats[statId];
}

/**
 * Clear cached settings (for testing or reload).
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}
