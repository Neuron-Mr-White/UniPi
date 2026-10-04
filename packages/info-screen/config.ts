/**
 * @pi-unipi/info-screen — Config system
 *
 * Reads/writes info-screen settings in ~/.pi/agent/settings.json
 * under the "unipi.info" key.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { InfoScreenSettings, GroupSettings, BootMode } from "./types.js";
import { DEFAULT_SETTINGS, BOOT_MODES } from "./types.js";

import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";

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
  // These were require() calls in an ESM module, which throws under Node's
  // module-format detection as soon as the directory is missing.
  const dir = dirname(SETTINGS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Get info-screen settings from settings.json.
 */
// Registered with the unified settings hub (engine imports the legacy
// pi-settings unipi.info block once via the A_KEY migration).
//
// The "Groups & stats" page resolves its sections from the LIVE group
// registry at open time (dynamic page), and "Group order" is an `order`
// field writing groupOrder — both replace the deleted legacy overlay
// overlay.
registerSettings({
  namespace: "info-screen",
  label: "Info Screen",
  defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Startup",
      fields: [
        {
          key: "bootMode",
          type: "enum",
          label: "Unicrab splash",
          description: "The Unicrab card shown at startup. /unipi:info opens the dashboard any time.",
          options: [
            { value: "auto-close", label: "auto-close", description: "show it, then fade out; never takes your keys" },
            { value: "on", label: "on", description: "keep it up until you press a key" },
            { value: "off", label: "off", description: "no splash" },
          ],
        },
        { key: "bootTimeoutMs", type: "number", label: "Splash time", unit: "ms", min: 500, description: "How long the splash stays up in auto-close mode." },
      ],
    },
    {
      title: "Pages",
      fields: [
        {
          key: "groups-page",
          type: "page",
          label: "Pages & stats…",
          description: "Choose which pages appear on the dashboard.",
          sections: () => {
            const registry = (globalThis as { __unipi_info_registry?: { getAllGroups(): Array<{ id: string; name: string; config: { stats: Array<{ id: string; label: string }> } }> } }).__unipi_info_registry;
            const groups = registry?.getAllGroups() ?? [];
            return groups.map((g) => ({
              title: g.name,
              fields: [
                { key: `groups.${g.id}.show`, type: "boolean" as const, label: `Show ${g.name}`, description: `Show the ${g.name} group on the dashboard.` },
                ...g.config.stats.map((s) => ({
                  key: `groups.${g.id}.stats.${s.id}`,
                  type: "boolean" as const,
                  label: s.label,
                  description: `Show the ${s.label} stat in the ${g.name} group.`,
                })),
              ],
            }));
          },
        },
        {
          key: "groupOrder",
          type: "order",
          label: "Page order",
          description: "Tab order of the dashboard pages.",
          items: () => {
            const registry = (globalThis as { __unipi_info_registry?: { getAllGroups(): Array<{ id: string; name: string }> } }).__unipi_info_registry;
            return (registry?.getAllGroups() ?? []).map((g) => ({ value: g.id, label: g.name }));
          },
        },
      ],
    },
  ],
});

/** `fresh` re-reads settings (dashboard open) so hub edits apply without a restart. */
export function getInfoSettings(fresh = false): InfoScreenSettings {
  if (cachedSettings && !fresh) return cachedSettings;

  const info = getSettings("info-screen", process.cwd());
  if (!isRecord(info) || Object.keys(info).length === 0) {
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  cachedSettings = {
    bootMode: parseBootMode(info),
    bootTimeoutMs: typeof info.bootTimeoutMs === "number" ? info.bootTimeoutMs : DEFAULT_SETTINGS.bootTimeoutMs,
    groups: isRecord(info.groups) ? parseGroupSettings(info.groups) : {},
    groupOrder: Array.isArray(info.groupOrder) ? info.groupOrder.filter((x): x is string => typeof x === "string") : [],
  };

  return cachedSettings;
}

/**
 * Resolve the boot mode, migrating the legacy `showOnBoot` boolean.
 *
 * `showOnBoot: false` maps to "off". `showOnBoot: true` maps to "on" rather
 * than the new "auto-close" default, so an existing config keeps behaving the
 * way its owner configured it.
 */
function parseBootMode(info: Record<string, unknown>): BootMode {
  const raw = info.bootMode;
  if (typeof raw === "string" && (BOOT_MODES as string[]).includes(raw)) {
    return raw as BootMode;
  }
  if (typeof info.showOnBoot === "boolean") {
    return info.showOnBoot ? "on" : "off";
  }
  return DEFAULT_SETTINGS.bootMode;
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
  setSettings("info-screen", settings as unknown as Record<string, unknown>, "global", process.cwd());
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
 * Check if a stat within a group is enabled.
 */
export function isStatEnabled(groupId: string, statId: string): boolean {
  const groupSettings = getGroupSettings(groupId);
  if (!groupSettings.stats) return true; // Default to enabled
  if (!(statId in groupSettings.stats)) return true;
  return groupSettings.stats[statId];
}
