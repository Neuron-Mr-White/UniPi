/**
 * @pi-unipi/footer — Configuration system
 *
 * Loads/saves footer settings from ~/.pi/agent/settings.json
 * under the `unipi.footer` key.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FooterSettings, FooterGroupSettings, SeparatorStyle, IconStyle } from "./types.js";
import { UNIPI_SETTINGS_KEY } from "@pi-unipi/core";

/** Default footer settings */
export const DEFAULT_FOOTER_SETTINGS: FooterSettings = {
  enabled: true,
  preset: "default",
  separator: "powerline-thin",
  iconStyle: "nerd",
  groups: {
    core: { show: true, segments: {} },
    compactor: { show: true, segments: {} },
    memory: { show: true, segments: {} },
    mcp: { show: true, segments: {} },
    ralph: { show: true, segments: {} },
    workflow: { show: true, segments: {} },
    kanboard: { show: true, segments: {} },
    notify: { show: false, segments: {} },
    status_ext: { show: true, segments: {} },
  },
};

/**
 * Get the path to pi's settings.json
 */
function getSettingsPath(): string {
  const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "settings.json");
}

/**
 * Read the raw settings.json file.
 * Returns null if file doesn't exist or is malformed.
 */
function readSettingsFile(): Record<string, unknown> | null {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) return null;
    const raw = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    console.warn("[footer] Failed to read settings.json:", err);
    return null;
  }
}

/**
 * Write settings back to settings.json.
 */
function writeSettingsFile(settings: Record<string, unknown>): boolean {
  try {
    const settingsPath = getSettingsPath();
    const dir = path.dirname(settingsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return true;
  } catch (err) {
    console.warn("[footer] Failed to write settings.json:", err);
    return false;
  }
}

/**
 * Load footer settings from settings.json.
 * Falls back to defaults for any missing fields.
 */
export function loadFooterSettings(): FooterSettings {
  const raw = readSettingsFile();
  if (!raw) return { ...DEFAULT_FOOTER_SETTINGS };

  try {
    const unipi = raw[UNIPI_SETTINGS_KEY] as Record<string, unknown> | undefined;
    if (!unipi) return { ...DEFAULT_FOOTER_SETTINGS };

    const footer = unipi.footer as Record<string, unknown> | undefined;
    if (!footer) return { ...DEFAULT_FOOTER_SETTINGS };

    return {
      enabled: typeof footer.enabled === "boolean" ? footer.enabled : DEFAULT_FOOTER_SETTINGS.enabled,
      preset: typeof footer.preset === "string" ? footer.preset : DEFAULT_FOOTER_SETTINGS.preset,
      separator: isValidSeparator(footer.separator) ? footer.separator as SeparatorStyle : DEFAULT_FOOTER_SETTINGS.separator,
      iconStyle: isValidIconStyle(footer.iconStyle) ? footer.iconStyle as IconStyle : DEFAULT_FOOTER_SETTINGS.iconStyle,
      groups: mergeGroupSettings(
        DEFAULT_FOOTER_SETTINGS.groups,
        footer.groups as Record<string, FooterGroupSettings> | undefined,
      ),
    };
  } catch (err) {
    console.warn("[footer] Failed to parse footer settings, using defaults:", err);
    return { ...DEFAULT_FOOTER_SETTINGS };
  }
}

/**
 * Save footer settings to settings.json.
 * Merges with existing settings (preserves other keys).
 */
export function saveFooterSettings(partial: Partial<FooterSettings>): boolean {
  const raw = readSettingsFile() ?? {};
  const unipi = (raw[UNIPI_SETTINGS_KEY] as Record<string, unknown>) ?? {};
  const existing = (unipi.footer as Record<string, unknown>) ?? {};

  unipi.footer = { ...existing, ...partial };
  raw[UNIPI_SETTINGS_KEY] = unipi;

  return writeSettingsFile(raw);
}

/**
 * Get settings for a specific group.
 * Falls back to defaults if group not configured.
 */
export function getGroupSettings(groupId: string): FooterGroupSettings {
  const settings = loadFooterSettings();
  return settings.groups[groupId] ?? { show: true, segments: {} };
}

/**
 * Check if a specific segment is enabled.
 * Respects both group-level and segment-level settings.
 */
export function isSegmentEnabled(groupId: string, segmentId: string): boolean {
  const groupSettings = getGroupSettings(groupId);
  if (!groupSettings.show) return false;
  if (groupSettings.segments && segmentId in groupSettings.segments) {
    return groupSettings.segments[segmentId] ?? true;
  }
  return true;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidSeparator(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const valid: string[] = ["powerline", "powerline-thin", "slash", "pipe", "dot", "ascii"];
  return valid.includes(value);
}

function isValidIconStyle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const valid: string[] = ["nerd", "emoji", "text"];
  return valid.includes(value);
}

function mergeGroupSettings(
  defaults: Record<string, FooterGroupSettings>,
  overrides: Record<string, FooterGroupSettings> | undefined,
): Record<string, FooterGroupSettings> {
  const result: Record<string, FooterGroupSettings> = { ...defaults };

  if (!overrides) return result;

  for (const [groupId, groupOverride] of Object.entries(overrides)) {
    const defaultGroup = result[groupId] ?? { show: true, segments: {} };
    result[groupId] = {
      show: typeof groupOverride.show === "boolean" ? groupOverride.show : defaultGroup.show,
      segments: {
        ...defaultGroup.segments,
        ...(groupOverride.segments ?? {}),
      },
    };
  }

  return result;
}
