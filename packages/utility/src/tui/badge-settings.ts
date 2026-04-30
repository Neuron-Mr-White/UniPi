/**
 * @pi-unipi/utility — Badge Settings Manager
 *
 * Thin wrappers over the unified settings manager (util-settings.json).
 * Existing callers continue to work unchanged.
 */

import {
  readUtilSettings,
  writeUtilSettings,
  type BadgeSettingsSection,
} from "../diff/settings.js";

/** Badge settings interface (re-exports BadgeSettingsSection for backward compat) */
export type BadgeSettings = BadgeSettingsSection;

/** Default badge settings for formatBadgeSettings display */
const BADGE_CONFIG_FILE = ".unipi/config/util-settings.json";

/**
 * Read badge settings from unified config.
 * Returns defaults if file doesn't exist or is malformed.
 */
export function readBadgeSettings(): BadgeSettings {
  return readUtilSettings().badge;
}

/**
 * Write badge settings to unified config.
 */
export function writeBadgeSettings(settings: BadgeSettings): void {
  const util = readUtilSettings();
  util.badge = settings;
  writeUtilSettings(util);
}

/**
 * Update a single badge setting.
 */
export function updateBadgeSetting<K extends keyof BadgeSettings>(
  key: K,
  value: BadgeSettings[K],
): BadgeSettings {
  const settings = readBadgeSettings();
  settings[key] = value;
  writeBadgeSettings(settings);
  return settings;
}

/**
 * Format badge settings for display.
 */
export function formatBadgeSettings(settings: BadgeSettings): string {
  const toggle = (v: boolean) => (v ? "✓ enabled" : "✗ disabled");
  return [
    "## Badge Settings",
    "",
    `| Setting | Status | Description |`,
    `|---------|--------|-------------|`,
    `| Auto Generate | ${toggle(settings.autoGen)} | Generate name on first message |`,
    `| Badge Enabled | ${toggle(settings.badgeEnabled)} | Show badge overlay |`,
    `| Agent Tool | ${toggle(settings.agentTool)} | Allow agents to call set_session_name |`,
    `| Generation Model | ${settings.generationModel} | Model for badge name generation |`,
    "",
    `Config: \`${BADGE_CONFIG_FILE}\``,
  ].join("\n");
}
