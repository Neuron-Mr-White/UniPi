/**
 * @pi-unipi/ask-user — Config system
 *
 * Reads/writes ask-user settings in ~/.pi/agent/settings.json
 * under the "unipi.askUser" key.
 */

import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";

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


let cachedSettings: AskUserSettings | null = null;

/**
 * Check if value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Get ask-user settings from settings.json.
 */
// Registered with the unified settings hub. The engine's migration imports
// the legacy ~/.pi/agent/settings.json unipi.askUser block once automatically.
registerSettings({
  namespace: "ask-user",
  label: "Ask User",
  defaults: DEFAULT_SETTINGS as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Tool",
      fields: [
        { key: "enabled", type: "boolean", label: "Enable ask_user tool", description: "Allow the agent to ask structured questions" },
        { key: "notifyOnAsk", type: "boolean", label: "Notify on ask", description: "Send a notification when the agent pauses to ask" },
      ],
    },
    {
      title: "Allowed formats",
      fields: [
        { key: "allowedFormats.singleSelect", type: "boolean", label: "Single-select", description: "Questions with one correct answer" },
        { key: "allowedFormats.multiSelect", type: "boolean", label: "Multi-select", description: "Questions with several answers" },
        { key: "allowedFormats.freeform", type: "boolean", label: "Freeform", description: "Plain text input" },
      ],
    },
  ],
});

export function getAskUserSettings(): AskUserSettings {
  if (cachedSettings) return cachedSettings;
  const askUser = getSettings("ask-user", process.cwd()) as Record<string, unknown>;
  if (!isRecord(askUser)) {
    cachedSettings = { ...DEFAULT_SETTINGS };
    return cachedSettings;
  }

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
  setSettings("ask-user", settings as unknown as Record<string, unknown>, "global", process.cwd());
  cachedSettings = settings;
}

/**
 * Clear cached settings (for testing or reload).
 */
export function clearSettingsCache(): void {
  cachedSettings = null;
}