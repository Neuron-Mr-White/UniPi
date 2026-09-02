/**
 * @pi-unipi/notify — Configuration management
 *
 * Loads, saves, and validates notification config from ~/.unipi/config/notify/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { NOTIFY_DIRS } from "@pi-unipi/core";
import { mergeSilenceAfterInput } from "./activity.js";
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
  },
  silenceAfterInput: {
    enabled: false,
    windowMs: 10000,
    platforms: ["native"],
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
  // Deep copy: callers (e.g. the settings overlay) mutate the returned config.
  // A shallow copy would share nested objects with DEFAULT_CONFIG and leak
  // mutations into later loadConfig() calls (even after Esc/cancel).
  return structuredClone(DEFAULT_CONFIG);
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
  };
}
