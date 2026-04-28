/**
 * @pi-unipi/utility — Badge Settings Manager
 *
 * Manages badge configuration stored in .unipi/config/badge.json.
 * Settings: autoGen, badgeEnabled, agentTool
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Badge settings interface */
export interface BadgeSettings {
  /** Auto-generate session name on first user message */
  autoGen: boolean;
  /** Show the badge overlay */
  badgeEnabled: boolean;
  /** Enable the set_session_name tool for agents */
  agentTool: boolean;
}

/** Default badge settings */
const DEFAULT_SETTINGS: BadgeSettings = {
  autoGen: true,
  badgeEnabled: true,
  agentTool: true,
};

/** Badge settings file name */
const BADGE_CONFIG_FILE = ".unipi/config/badge.json";

/**
 * Get the config file path relative to cwd.
 */
function getConfigPath(): string {
  return path.resolve(process.cwd(), BADGE_CONFIG_FILE);
}

/**
 * Read badge settings from disk.
 * Returns defaults if file doesn't exist or is malformed.
 */
export function readBadgeSettings(): BadgeSettings {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      autoGen: typeof parsed.autoGen === "boolean" ? parsed.autoGen : DEFAULT_SETTINGS.autoGen,
      badgeEnabled: typeof parsed.badgeEnabled === "boolean" ? parsed.badgeEnabled : DEFAULT_SETTINGS.badgeEnabled,
      agentTool: typeof parsed.agentTool === "boolean" ? parsed.agentTool : DEFAULT_SETTINGS.agentTool,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Write badge settings to disk.
 * Creates .unipi/config/ directory if needed.
 */
export function writeBadgeSettings(settings: BadgeSettings): void {
  try {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {
    // Best effort
  }
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
    "",
    `Config: \`${BADGE_CONFIG_FILE}\``,
  ].join("\n");
}
