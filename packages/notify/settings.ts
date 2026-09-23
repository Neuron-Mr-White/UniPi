/**
 * @pi-unipi/notify — Configuration management
 *
 * Loads, saves, and validates notification config from ~/.unipi/config/notify/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { NOTIFY_DIRS, getSettings, registerSettings, setSettings } from "@pi-unipi/core";
import { mergeSilenceAfterInput } from "./activity.js";
import type { NotifyConfig, RenotifyConfig } from "./types.js";

/** Resolve config path (expands ~ to homedir) */
function resolveConfigPath(): string {
  const base = NOTIFY_DIRS.CONFIG.replace("~", homedir());
  return join(base, "config.json");
}

/** Default configuration — native enabled, gotify/telegram disabled */
export const DEFAULT_CONFIG: NotifyConfig = {
  defaultPlatforms: ["native"],
  events: {
    workflow_end: { enabled: true, platforms: [] },
    ralph_loop_end: { enabled: true, platforms: [] },
    mcp_server_error: { enabled: true, platforms: [] },
    agent_end: { enabled: false, platforms: [] },
    agent_settled: { enabled: false, platforms: [] },
    memory_consolidated: { enabled: false, platforms: [] },
    session_shutdown: { enabled: false, platforms: [] },
    ask_user_prompt: { enabled: false, platforms: [] },
    permission_request: { enabled: false, platforms: [] },
  },
  native: {
    enabled: true,
    suppressWhenFocused: false,
  },
  gotify: {
    enabled: false,
    priority: 5,
  },
  telegram: {
    enabled: false,
  },
  recap: {
    enabled: false,
    model: "openrouter/openai/gpt-oss-20b",
    disableThinking: false,
  },
  silenceAfterInput: {
    enabled: false,
    windowMs: 10000,
    platforms: ["native"],
  },
  renotify: {
    enabled: true,
    intervalMs: 120000,
    maxRepeats: 3,
  },
};

/** Load config from disk, returning defaults if missing or invalid */
// Registered with the unified settings hub. The canonical file
// (~/.unipi/config/notify/config.json) is exactly what this module already
// used, so switching to the engine is a no-op on disk.
registerSettings({
  namespace: "notify",
  label: "Notify",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "General",
      description: "Event-by-event routing lives in /unipi:notify-settings",
      fields: [
        { key: "native.enabled", type: "boolean", label: "Native desktop", description: "OS notifications" },
        { key: "native.suppressWhenFocused", type: "boolean", label: "Quiet when focused" },
        { key: "recap.enabled", type: "boolean", label: "Recap", description: "Session recap digests" },
        { key: "recap.model", type: "model", label: "Recap model", emptyLabel: "inherit (session model)", capability: "text", emptyOption: "inherit (session model)" },
      ],
    },
    {
      title: "Platforms",
      description: "Per-platform credentials and targets",
      fields: [
        {
          key: "gotify",
          type: "page",
          label: "gotify",
          sections: [
            {
              title: "gotify",
              fields: [
                { key: "gotify.enabled", type: "boolean", label: "Enabled" },
                { key: "gotify.serverUrl", type: "string", label: "Server URL", emptyLabel: "https://gotify.example" },
                { key: "gotify.appToken", type: "secret", label: "App token", emptyLabel: "unset" },
                { key: "gotify.priority", type: "number", label: "Priority", min: 0, max: 10 },
              ],
            },
          ],
        },
        {
          key: "telegram",
          type: "page",
          label: "telegram",
          sections: [
            {
              title: "telegram",
              fields: [
                { key: "telegram.enabled", type: "boolean", label: "Enabled" },
                { key: "telegram.botToken", type: "secret", label: "Bot token", emptyLabel: "unset" },
                { key: "telegram.chatId", type: "secret", label: "Chat ID", emptyLabel: "unset" },
              ],
            },
          ],
        },
        {
          key: "ntfy",
          type: "page",
          label: "ntfy",
          sections: [
            {
              title: "ntfy",
              fields: [
                { key: "ntfy.enabled", type: "boolean", label: "Enabled" },
                { key: "ntfy.serverUrl", type: "string", label: "Server", emptyLabel: "https://ntfy.sh" },
                { key: "ntfy.topic", type: "string", label: "Topic", emptyLabel: "unset" },
                { key: "ntfy.token", type: "secret", label: "Access token", emptyLabel: "unset" },
                { key: "ntfy.priority", type: "number", label: "Priority", min: 1, max: 5 },
              ],
            },
          ],
        },
      ],
    },
  ],
});

export function loadConfig(): NotifyConfig {
  try {
    const parsed = getSettings("notify", process.cwd()) as Partial<NotifyConfig>;
    return mergeWithDefaults(parsed);
  } catch (_err) {
    // Config load failure — using defaults silently.
  }
  // Deep copy: callers (e.g. the settings overlay) mutate the returned config.
  // A shallow copy would share nested objects with DEFAULT_CONFIG and leak
  // mutations into later loadConfig() calls (even after Esc/cancel).
  return structuredClone(DEFAULT_CONFIG);
}

/** Save config to disk, creating directory if needed */
export function saveConfig(config: NotifyConfig): void {
  setSettings("notify", config as unknown as Record<string, unknown>, "global", process.cwd());
}

/** Update config with partial changes */
export function updateConfig(partial: Partial<NotifyConfig>): NotifyConfig {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  saveConfig(updated);
  return updated;
}

/** Validate that a config has required fields for enabled platforms */
export function validateConfig(config: NotifyConfig): string[] {
  const errors: string[] = [];

  if (config.gotify.enabled) {
    if (!config.gotify.serverUrl) {
      errors.push("Gotify: serverUrl is required");
    }
    if (!config.gotify.appToken) {
      errors.push("Gotify: appToken is required");
    }
  }

  if (config.telegram.enabled) {
    if (!config.telegram.botToken) {
      errors.push("Telegram: botToken is required");
    }
    if (!config.telegram.chatId) {
      errors.push("Telegram: chatId is required");
    }
  }

  if (config.gotify.priority < 1 || config.gotify.priority > 10) {
    errors.push("Gotify: priority must be between 1 and 10");
  }

  return errors;
}

/** Merge loaded config with defaults to ensure all fields exist */
function mergeWithDefaults(loaded: Partial<NotifyConfig>): NotifyConfig {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    defaultPlatforms: loaded.defaultPlatforms ?? base.defaultPlatforms,
    events: { ...base.events, ...loaded.events },
    native: { ...base.native, ...loaded.native },
    gotify: { ...base.gotify, ...loaded.gotify },
    telegram: { ...base.telegram, ...loaded.telegram },
    recap: { ...base.recap, ...loaded.recap },
    silenceAfterInput: mergeSilenceAfterInput(
      loaded.silenceAfterInput,
      base.silenceAfterInput,
    ),
    renotify: mergeRenotify(loaded.renotify, base.renotify),
  };
}

/** Merge the renotify block, falling back per-field on invalid scalars. */
function mergeRenotify(
  loaded: Partial<RenotifyConfig> | undefined,
  defaults: RenotifyConfig,
): RenotifyConfig {
  const intervalMs =
    typeof loaded?.intervalMs === "number" &&
    Number.isFinite(loaded.intervalMs) &&
    loaded.intervalMs >= 10000
      ? loaded.intervalMs
      : defaults.intervalMs;
  const maxRepeats =
    typeof loaded?.maxRepeats === "number" &&
    Number.isInteger(loaded.maxRepeats) &&
    loaded.maxRepeats >= 0
      ? loaded.maxRepeats
      : defaults.maxRepeats;
  return {
    enabled: loaded?.enabled ?? defaults.enabled,
    intervalMs,
    maxRepeats,
  };
}
