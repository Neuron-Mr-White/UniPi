/**
 * @pi-unipi/utility — Settings Manager
 *
 * Manages badge settings in `.unipi/config/util-settings.json`.
 * Migrates from legacy `badge.json` on first read.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Badge settings */
export interface BadgeSettingsSection {
  autoGen: boolean;
  badgeEnabled: boolean;
  agentTool: boolean;
  generationModel: string;
}

/** Unified utility settings */
export interface UtilSettings {
  badge: BadgeSettingsSection;
}

/** Default badge settings */
const DEFAULT_BADGE_SETTINGS: BadgeSettingsSection = {
  autoGen: true,
  badgeEnabled: true,
  agentTool: true,
  generationModel: "inherit",
};

/** Default unified settings */
const DEFAULT_SETTINGS: UtilSettings = {
  badge: { ...DEFAULT_BADGE_SETTINGS },
};

/** Config file paths */
const UTIL_SETTINGS_FILE = ".unipi/config/util-settings.json";
const BADGE_CONFIG_FILE = ".unipi/config/badge.json";

function getConfigPath(file: string): string {
  return path.resolve(process.cwd(), file);
}

/**
 * Read badge.json for migration purposes.
 * Returns null if file doesn't exist or is malformed.
 */
function readLegacyBadgeSettings(): BadgeSettingsSection | null {
  try {
    const configPath = getConfigPath(BADGE_CONFIG_FILE);
    if (!fs.existsSync(configPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      autoGen: typeof parsed.autoGen === "boolean" ? parsed.autoGen : DEFAULT_BADGE_SETTINGS.autoGen,
      badgeEnabled: typeof parsed.badgeEnabled === "boolean" ? parsed.badgeEnabled : DEFAULT_BADGE_SETTINGS.badgeEnabled,
      agentTool: typeof parsed.agentTool === "boolean" ? parsed.agentTool : DEFAULT_BADGE_SETTINGS.agentTool,
      generationModel: typeof parsed.generationModel === "string" ? parsed.generationModel : DEFAULT_BADGE_SETTINGS.generationModel,
    };
  } catch {
    return null;
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, data, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

export function readUtilSettings(): UtilSettings {
  try {
    const configPath = getConfigPath(UTIL_SETTINGS_FILE);

    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return normalizeSettings(parsed);
    }

    const legacyBadge = readLegacyBadgeSettings();
    if (legacyBadge) {
      const migrated: UtilSettings = { badge: legacyBadge };
      writeUtilSettings(migrated);
      return migrated;
    }

    return { ...DEFAULT_SETTINGS, badge: { ...DEFAULT_BADGE_SETTINGS } };
  } catch {
    return { ...DEFAULT_SETTINGS, badge: { ...DEFAULT_BADGE_SETTINGS } };
  }
}

export function writeUtilSettings(settings: UtilSettings): void {
  try {
    const configPath = getConfigPath(UTIL_SETTINGS_FILE);
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    atomicWrite(configPath, JSON.stringify(settings, null, 2) + "\n");
  } catch {
    // Best effort
  }
}

function normalizeSettings(parsed: any): UtilSettings {
  return {
    badge: {
      autoGen: typeof parsed?.badge?.autoGen === "boolean" ? parsed.badge.autoGen : DEFAULT_BADGE_SETTINGS.autoGen,
      badgeEnabled: typeof parsed?.badge?.badgeEnabled === "boolean" ? parsed.badge.badgeEnabled : DEFAULT_BADGE_SETTINGS.badgeEnabled,
      agentTool: typeof parsed?.badge?.agentTool === "boolean" ? parsed.badge.agentTool : DEFAULT_BADGE_SETTINGS.agentTool,
      generationModel: typeof parsed?.badge?.generationModel === "string" ? parsed.badge.generationModel : DEFAULT_BADGE_SETTINGS.generationModel,
    },
  };
}

/** Read only the badge settings section. */
export function readBadgeSettings(): BadgeSettingsSection {
  return readUtilSettings().badge;
}

/** Write partial badge settings (merged with existing). */
export function writeBadgeSettings(partial: Partial<BadgeSettingsSection>): void {
  const settings = readUtilSettings();
  settings.badge = { ...settings.badge, ...partial };
  writeUtilSettings(settings);
}

/** Update a single badge setting. */
export function updateBadgeSetting<K extends keyof BadgeSettingsSection>(
  key: K,
  value: BadgeSettingsSection[K],
): BadgeSettingsSection {
  const settings = readBadgeSettings();
  settings[key] = value;
  writeBadgeSettings(settings);
  return settings;
}

/** Format badge settings for display. */
export function formatBadgeSettings(settings: BadgeSettingsSection): string {
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
    `Config: .unipi/config/util-settings.json`,
  ].join("\n");
}
