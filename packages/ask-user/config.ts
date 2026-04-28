/**
 * @pi-unipi/ask-user — Config system
 *
 * Reads/writes ask-user settings in ~/.pi/agent/settings.json
 * under the "unipi.askUser" key.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Ask-user settings */
export interface AskUserSettings {
  /** Whether the ask_user tool is enabled */
  enabled: boolean;
  /** Allowed question formats */
  allowedFormats: {
    /** Allow single-select questions */
    singleSelect: boolean;
    /** Allow multi-select questions */
    multiSelect: boolean;
    /** Allow freeform text input */
    freeform: boolean;
  };
  /** Send notification when agent pauses to ask a question */
  notifyOnAsk: boolean;
}

/** Default settings */
export const DEFAULT_SETTINGS: AskUserSettings = {
  enabled: true,
  allowedFormats: {
    singleSelect: true,
    multiSelect: true,
    freeform: true,
  },
  notifyOnAsk: true,
};

/** Settings path */
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Settings key within settings.json */
const SETTINGS_KEY = "unipi";

/** Cached settings */
let cachedSettings: AskUserSettings | null = null;

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
 * Get ask-user settings from settings.json.
 */
export function getAskUserSettings(): AskUserSettings {
  if (cachedSettings) return cachedSettings;

  const settings = readSettingsFile();
  const unipi = settings[SETTINGS_KEY];

  if (!isRecord(unipi) || !isRecord(unipi.askUser)) {
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

  const askUser = unipi.askUser as Record<string, unknown>;

  const enabled = typeof askUser.enabled === "boolean" ? askUser.enabled : DEFAULT_SETTINGS.enabled;

  let allowedFormats = DEFAULT_SETTINGS.allowedFormats;
  if (isRecord(askUser.allowedFormats)) {
    const fmt = askUser.allowedFormats;
    allowedFormats = {
      singleSelect: typeof fmt.singleSelect === "boolean" ? fmt.singleSelect : DEFAULT_SETTINGS.allowedFormats.singleSelect,
      multiSelect: typeof fmt.multiSelect === "boolean" ? fmt.multiSelect : DEFAULT_SETTINGS.allowedFormats.multiSelect,
      freeform: typeof fmt.freeform === "boolean" ? fmt.freeform : DEFAULT_SETTINGS.allowedFormats.freeform,
    };
  }

  const notifyOnAsk = typeof askUser.notifyOnAsk === "boolean" ? askUser.notifyOnAsk : DEFAULT_SETTINGS.notifyOnAsk;

  cachedSettings = { enabled, allowedFormats, notifyOnAsk };
  return cachedSettings;
}

/**
 * Save ask-user settings to settings.json.
 */
export function saveAskUserSettings(settings: AskUserSettings): void {
  const file = readSettingsFile();

  if (!isRecord(file[SETTINGS_KEY])) {
    file[SETTINGS_KEY] = {};
  }

  (file[SETTINGS_KEY] as Record<string, unknown>).askUser = {
    enabled: settings.enabled,
    allowedFormats: settings.allowedFormats,
    notifyOnAsk: settings.notifyOnAsk,
  };

  writeSettingsFile(file);
  cachedSettings = settings;
}

/**
 * Clear cached settings (for testing or reload).
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}