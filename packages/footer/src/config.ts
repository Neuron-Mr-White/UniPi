/**
 * @pi-unipi/footer — Configuration system
 *
 * Loads/saves footer settings from ~/.pi/agent/settings.json
 * under the `unipi.footer` key.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { FooterSettings, FooterGroupSettings, SeparatorStyle, IconStyle, ColorMode } from "./types.js";
import { UNIPI_SETTINGS_KEY, getSettings, registerSettings, setSettings } from "@pi-unipi/core";
import { getFooterRegistry } from "./registry/index.js";

/** Default footer settings */
export const DEFAULT_FOOTER_SETTINGS: FooterSettings = {
  enabled: true,
  preset: "default",
  glanceMode: true,
  separator: "powerline-thin",
  iconStyle: "nerd",
  zoneSeparator: "\u2502", // │
  showFullLabels: false,
  colorMode: "auto",
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
  } catch {
    // Silently ignore — settings read failure falls back to null.
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
  } catch {
    // Silently ignore — settings write failure is non-blocking.
    return false;
  }
}

/**
 * Load footer settings from settings.json.
 * Falls back to defaults for any missing fields.
 */
// Registered with the unified settings hub; the engine's migration imports
// the legacy pi-settings unipi.footer block into the canonical layout once.
// The "Segments…" page resolves sections from the LIVE FooterRegistry at
// open time — it replaces the deleted /unipi:footer-settings overlay.
registerSettings({
  namespace: "footer",
  label: "Footer",
  defaults: DEFAULT_FOOTER_SETTINGS as unknown as Record<string, unknown>,
  schema: [
    {
      title: "General",
      fields: [
        { key: "enabled", type: "boolean", label: "Footer enabled" },
        {
          key: "preset",
          type: "enum",
          label: "Preset",
          options: ["default", "classic", "minimal", "dense", "devops", "zen"],
          description: "Segment layout preset (glance mode uses its own frame)",
        },
        { key: "glanceMode", type: "boolean", label: "Glance mode", description: "The input-box frame renderer" },
        { key: "showFullLabels", type: "boolean", label: "Full labels", description: "Labeled instead of compact segments" },
        {
          key: "separator",
          type: "enum",
          label: "Separator",
          description: "Segment divider style",
          options: ["powerline", "powerline-thin", "slash", "pipe", "dot", "ascii"],
        },
        {
          key: "zoneSeparator",
          type: "enum",
          label: "Zone separator",
          description: "Divider between zones (left · center · right)",
          options: ["│", "╎", "·", "─", "none"],
        },
        {
          key: "iconStyle",
          type: "enum",
          label: "Icon style",
          options: [
            { value: "emoji", label: "emoji" },
            { value: "nerd", label: "nerd font" },
            { value: "text", label: "text only" },
          ],
        },
        {
          key: "colorMode",
          type: "enum",
          label: "Color mode",
          options: ["auto", "truecolor", "256", "mono"],
        },
      ],
    },
    {
      title: "Segments",
      fields: [
        {
          key: "segments-page",
          type: "page",
          label: "Segments…",
          description: "Per-group and per-segment visibility",
          sections: () =>
            getFooterRegistry().getAllGroups().map((g) => ({
              title: g.name,
              fields: [
                { key: `groups.${g.id}.show`, type: "boolean" as const, label: `Show ${g.name}` },
                ...g.segments.map((seg) => ({
                  key: `groups.${g.id}.segments.${seg.id}`,
                  type: "boolean" as const,
                  label: seg.label,
                })),
              ],
            })),
        },
      ],
    },
  ],
});

export function loadFooterSettings(): FooterSettings {
  const footer = getSettings("footer", process.cwd());
  try {
    return {
      enabled: typeof footer.enabled === "boolean" ? footer.enabled : DEFAULT_FOOTER_SETTINGS.enabled,
      preset: typeof footer.preset === "string" ? footer.preset : DEFAULT_FOOTER_SETTINGS.preset,
      glanceMode: typeof footer.glanceMode === "boolean" ? footer.glanceMode : DEFAULT_FOOTER_SETTINGS.glanceMode,
      separator: isValidSeparator(footer.separator) ? footer.separator as SeparatorStyle : DEFAULT_FOOTER_SETTINGS.separator,
      iconStyle: isValidIconStyle(footer.iconStyle) ? footer.iconStyle as IconStyle : DEFAULT_FOOTER_SETTINGS.iconStyle,
      zoneSeparator: typeof footer.zoneSeparator === "string" ? footer.zoneSeparator : DEFAULT_FOOTER_SETTINGS.zoneSeparator,
      showFullLabels: typeof footer.showFullLabels === "boolean" ? footer.showFullLabels : DEFAULT_FOOTER_SETTINGS.showFullLabels,
      colorMode: isValidColorMode(footer.colorMode) ? footer.colorMode as ColorMode : DEFAULT_FOOTER_SETTINGS.colorMode,
      groups: mergeGroupSettings(
        DEFAULT_FOOTER_SETTINGS.groups,
        footer.groups as Record<string, FooterGroupSettings> | undefined,
      ),
    };
  } catch {
    // Silently ignore — parse failure falls back to defaults.
    return { ...DEFAULT_FOOTER_SETTINGS };
  }
}

/**
 * Save footer settings to settings.json.
 * Merges with existing settings (preserves other keys).
 */
export function saveFooterSettings(partial: Partial<FooterSettings>): boolean {
  try {
    setSettings("footer", partial as Record<string, unknown>, "global", process.cwd());
    return true;
  } catch {
    return false;
  }
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

/**
 * Check if a segment is explicitly enabled by user settings (toggled on).
 * Returns true only if the segment appears in the settings with value `true`.
 * Segments that are enabled by default but not explicitly configured return false.
 */
export function isSegmentExplicitlyEnabled(groupId: string, segmentId: string): boolean {
  const settings = loadFooterSettings();
  const groupSettings = settings.groups[groupId];
  if (!groupSettings) return false;
  return groupSettings.segments?.[segmentId] === true;
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

function isValidColorMode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const valid: string[] = ["auto", "truecolor", "256", "none"];
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
