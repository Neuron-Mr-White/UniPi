/**
 * @pi-unipi/utility — Unified Settings Manager
 *
 * Manages both badge and diff settings in a single `.unipi/config/util-settings.json` file.
 * Migrates from legacy `badge.json` on first read.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Diff rendering settings */
export interface DiffSettings {
  /** Enable Shiki-powered diff rendering for write/edit tools */
  enabled: boolean;
  /** Diff theme preset: "default" | "midnight" | "subtle" | "neon" */
  theme: string;
  /** Shiki syntax theme name */
  shikiTheme: string;
  /** Minimum terminal columns for split view */
  splitMinWidth: number;
}

/** Badge settings (matches existing BadgeSettings interface) */
export interface BadgeSettingsSection {
  autoGen: boolean;
  badgeEnabled: boolean;
  agentTool: boolean;
  generationModel: string;
}

/** Unified utility settings */
export interface UtilSettings {
  badge: BadgeSettingsSection;
  diff: DiffSettings;
}

/** Default diff settings */
const DEFAULT_DIFF_SETTINGS: DiffSettings = {
  enabled: true,
  theme: "default",
  shikiTheme: "github-dark",
  splitMinWidth: 150,
};

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
  diff: { ...DEFAULT_DIFF_SETTINGS },
};

/** Config file paths */
const UTIL_SETTINGS_FILE = ".unipi/config/util-settings.json";
const BADGE_CONFIG_FILE = ".unipi/config/badge.json";

/**
 * Get absolute path for a config file relative to cwd.
 */
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

/**
 * Atomic write: write to temp file then rename.
 * Prevents corruption if two instances write simultaneously.
 */
function atomicWrite(filePath: string, data: string): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, data, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read the unified util-settings.json.
 * On first read, migrates from badge.json if it exists.
 * Returns defaults if no config exists.
 */
export function readUtilSettings(): UtilSettings {
  try {
    const configPath = getConfigPath(UTIL_SETTINGS_FILE);

    // Check if unified config exists
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return normalizeSettings(parsed);
    }

    // Migration: import from badge.json if it exists
    const legacyBadge = readLegacyBadgeSettings();
    if (legacyBadge) {
      const migrated: UtilSettings = {
        badge: legacyBadge,
        diff: { ...DEFAULT_DIFF_SETTINGS },
      };
      writeUtilSettings(migrated);
      return migrated;
    }

    // No config at all — return defaults (don't write yet)
    return { ...DEFAULT_SETTINGS, badge: { ...DEFAULT_BADGE_SETTINGS }, diff: { ...DEFAULT_DIFF_SETTINGS } };
  } catch {
    return { ...DEFAULT_SETTINGS, badge: { ...DEFAULT_BADGE_SETTINGS }, diff: { ...DEFAULT_DIFF_SETTINGS } };
  }
}

/**
 * Write the full unified settings to disk.
 */
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

/**
 * Normalize a parsed JSON object into valid UtilSettings.
 */
function normalizeSettings(parsed: any): UtilSettings {
  return {
    badge: {
      autoGen: typeof parsed?.badge?.autoGen === "boolean" ? parsed.badge.autoGen : DEFAULT_BADGE_SETTINGS.autoGen,
      badgeEnabled: typeof parsed?.badge?.badgeEnabled === "boolean" ? parsed.badge.badgeEnabled : DEFAULT_BADGE_SETTINGS.badgeEnabled,
      agentTool: typeof parsed?.badge?.agentTool === "boolean" ? parsed.badge.agentTool : DEFAULT_BADGE_SETTINGS.agentTool,
      generationModel: typeof parsed?.badge?.generationModel === "string" ? parsed.badge.generationModel : DEFAULT_BADGE_SETTINGS.generationModel,
    },
    diff: {
      enabled: typeof parsed?.diff?.enabled === "boolean" ? parsed.diff.enabled : DEFAULT_DIFF_SETTINGS.enabled,
      theme: typeof parsed?.diff?.theme === "string" ? parsed.diff.theme : DEFAULT_DIFF_SETTINGS.theme,
      shikiTheme: typeof parsed?.diff?.shikiTheme === "string" ? parsed.diff.shikiTheme : DEFAULT_DIFF_SETTINGS.shikiTheme,
      splitMinWidth: typeof parsed?.diff?.splitMinWidth === "number" ? parsed.diff.splitMinWidth : DEFAULT_DIFF_SETTINGS.splitMinWidth,
    },
  };
}

/**
 * Read only the diff settings section.
 */
export function readDiffSettings(): DiffSettings {
  return readUtilSettings().diff;
}

/**
 * Write partial diff settings (merged with existing).
 */
export function writeDiffSettings(partial: Partial<DiffSettings>): void {
  const settings = readUtilSettings();
  settings.diff = { ...settings.diff, ...partial };
  writeUtilSettings(settings);
}

/**
 * Read only the badge settings section.
 */
export function readBadgeSettingsFromUtil(): BadgeSettingsSection {
  return readUtilSettings().badge;
}

/**
 * Write partial badge settings (merged with existing).
 */
export function writeBadgeSettingsToUtil(partial: Partial<BadgeSettingsSection>): void {
  const settings = readUtilSettings();
  settings.badge = { ...settings.badge, ...partial };
  writeUtilSettings(settings);
}
