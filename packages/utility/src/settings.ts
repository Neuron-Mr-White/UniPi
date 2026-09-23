/**
 * @pi-unipi/utility — Settings Manager
 *
 * Manages badge settings in `.unipi/config/util-settings.json`.
 * Migrates from legacy `badge.json` on first read.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getSettings, registerSettings, setSettings, settingsLayers } from "@pi-unipi/core";

/** Badge settings */
export interface BadgeSettingsSection {
  autoGen: boolean;
  badgeEnabled: boolean;
  agentTool: boolean;
  generationModel: string;
  /** Sync session name to herdr pane title + tab label (when running inside herdr). */
  herdrSync: boolean;
}

/** Skill discovery settings (migrated from unipi.skills.discovery). */
export interface SkillDiscoverySection {
  discovery: boolean;
}

/** Unified utility settings */
export interface UtilSettings {
  badge: BadgeSettingsSection;
  skills: SkillDiscoverySection;
}

/** Default badge settings */
const DEFAULT_BADGE_SETTINGS: BadgeSettingsSection = {
  autoGen: true,
  badgeEnabled: true,
  agentTool: true,
  generationModel: "inherit",
  herdrSync: true,
};

/** Default skill discovery settings */
const DEFAULT_SKILL_DISCOVERY: SkillDiscoverySection = {
  discovery: true,
};

/** Default unified settings */
const DEFAULT_SETTINGS: UtilSettings = {
  badge: { ...DEFAULT_BADGE_SETTINGS },
  skills: { ...DEFAULT_SKILL_DISCOVERY },
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
      herdrSync: typeof parsed.herdrSync === "boolean" ? parsed.herdrSync : DEFAULT_BADGE_SETTINGS.herdrSync,
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

// Registered with the unified settings hub. Badge settings are project-scoped
// (they live with the repo), so the hub's project scope is the primary target.
registerSettings({
  namespace: "utility",
  label: "Utility",
  defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Badge",
      description: "Session name badge",
      fields: [
        { key: "badge.badgeEnabled", type: "boolean", label: "Badge enabled", description: "Show the session-name badge" },
        { key: "badge.autoGen", type: "boolean", label: "Auto-generate name", description: "Generate a session name on demand" },
        { key: "badge.agentTool", type: "boolean", label: "Agent tool", description: "Expose the badge tool to the agent" },
        { key: "badge.herdrSync", type: "boolean", label: "Herdr sync", description: "Sync session name to herdr pane title" },
        { key: "badge.generationModel", type: "model", label: "Generation model", emptyLabel: "inherit (session model)", capability: "text", emptyOption: "inherit (session model)" },
      ],
    },
    {
      title: "Skills",
      description: "Skill startup discovery",
      fields: [
        { key: "skills.discovery", type: "boolean", label: "Skill discovery", description: "Catalog skills in the system prompt at startup; off = invoke-only via /skill:name" },
      ],
    },
  ],
});

/**
 * One-time import of `unipi.skills.discovery` from pi's settings.json into the
 * engine layout (global scope), so the hub owns the value from here on.
 */
function importLegacySkillDiscovery(): void {
  try {
    const agentDir = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const raw = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8")) as {
      unipi?: { skills?: { discovery?: unknown } };
    };
    const discovery = raw?.unipi?.skills?.discovery;
    if (typeof discovery !== "boolean") return;
    if (settingsLayers("utility", process.cwd()).global) return; // engine value wins
    setSettings("utility", { skills: { discovery } } as unknown as Record<string, unknown>, "global", process.cwd());
  } catch {
    // Absent/unreadable legacy value — default applies.
  }
}

/** One-time import from the legacy <cwd>/.unipi/config/util-settings.json. */
function importLegacyUtilSettings(): void {
  const layers = settingsLayers("utility", process.cwd());
  if (layers.global || layers.project) return;
  const legacy = (() => {
    try {
      const configPath = getConfigPath(UTIL_SETTINGS_FILE);
      if (!fs.existsSync(configPath)) return null;
      return normalizeSettings(JSON.parse(fs.readFileSync(configPath, "utf-8")));
    } catch {
      return null;
    }
  })();
  if (legacy) {
    setSettings("utility", legacy as unknown as Record<string, unknown>, "project", process.cwd());
    return;
  }
  const legacyBadge = readLegacyBadgeSettings();
  if (legacyBadge) {
    setSettings("utility", { badge: legacyBadge } as unknown as Record<string, unknown>, "project", process.cwd());
  }
}

export function readUtilSettings(): UtilSettings {
  try {
    importLegacyUtilSettings();
    importLegacySkillDiscovery();
    const raw = getSettings("utility", process.cwd());
    const normalized = normalizeSettings(raw);
    if (normalized) return normalized;
    return { ...DEFAULT_SETTINGS, badge: { ...DEFAULT_BADGE_SETTINGS } };
  } catch {
    return { ...DEFAULT_SETTINGS, badge: { ...DEFAULT_BADGE_SETTINGS } };
  }
}

export function writeUtilSettings(settings: UtilSettings): void {
  try {
    // Badge settings are project-scoped — they travel with the repo.
    setSettings("utility", settings as unknown as Record<string, unknown>, "project", process.cwd());
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
      herdrSync: typeof parsed?.badge?.herdrSync === "boolean" ? parsed.badge.herdrSync : DEFAULT_BADGE_SETTINGS.herdrSync,
    },
    skills: {
      discovery: typeof parsed?.skills?.discovery === "boolean" ? parsed.skills.discovery : DEFAULT_SKILL_DISCOVERY.discovery,
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
    `| Herdr Sync | ${toggle(settings.herdrSync)} | Sync session name to herdr tab/pane title |`,
    `| Generation Model | ${settings.generationModel} | Model for badge name generation |`,
    "",
    `Config: .unipi/config/util-settings.json`,
  ].join("\n");
}
