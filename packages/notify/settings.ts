/**
 * @pi-unipi/notify — Configuration management
 *
 * Loads, saves, and validates notification config from ~/.unipi/config/notify/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { NOTIFY_DIRS } from "@pi-unipi/core";
import type { NotifyConfig } from "./types.js";

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
    memory_consolidated: { enabled: false, platforms: [] },
    session_shutdown: { enabled: false, platforms: [] },
    ask_user_prompt: { enabled: false, platforms: [] },
  },
  native: {
    enabled: true,
  },
  gotify: {
    enabled: false,
    priority: 5,
  },
  telegram: {
    enabled: false,
  },
  ntfy: {
    enabled: false,
    serverUrl: "https://ntfy.sh",
    priority: 3,
  },
  recap: {
    enabled: false,
    model: "openrouter/openai/gpt-oss-20b",
  },
};

/** Load config from disk, returning defaults if missing or invalid */
export function loadConfig(): NotifyConfig {
  const configPath = resolveConfigPath();
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<NotifyConfig>;
      // Merge with defaults to ensure new fields are present
      return mergeWithDefaults(parsed);
    }
  } catch (_err) {
    // Config load failure — using defaults silently.
  }
  return { ...DEFAULT_CONFIG };
}

/** Save config to disk, creating directory if needed */
export function saveConfig(config: NotifyConfig): void {
  const configPath = resolveConfigPath();
  const dir = dirname(configPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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

  if (config.ntfy.enabled) {
    if (!config.ntfy.serverUrl) {
      errors.push("ntfy: serverUrl is required");
    }
    if (!config.ntfy.topic) {
      errors.push("ntfy: topic is required");
    }
  }

  if (config.ntfy.priority < 1 || config.ntfy.priority > 5) {
    errors.push("ntfy: priority must be between 1 and 5");
  }

  return errors;
}

/** Merge loaded config with defaults to ensure all fields exist */
function mergeWithDefaults(loaded: Partial<NotifyConfig>): NotifyConfig {
  return {
    defaultPlatforms: loaded.defaultPlatforms ?? DEFAULT_CONFIG.defaultPlatforms,
    events: { ...DEFAULT_CONFIG.events, ...loaded.events },
    native: { ...DEFAULT_CONFIG.native, ...loaded.native },
    gotify: { ...DEFAULT_CONFIG.gotify, ...loaded.gotify },
    telegram: { ...DEFAULT_CONFIG.telegram, ...loaded.telegram },
    ntfy: { ...DEFAULT_CONFIG.ntfy, ...loaded.ntfy },
    recap: { ...DEFAULT_CONFIG.recap, ...loaded.recap },
  };
}
