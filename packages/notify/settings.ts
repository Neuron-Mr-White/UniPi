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
    input_needed: { enabled: false, platforms: [] },
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
/** Platform options shared by every multiselect in the schema. */
const PLATFORM_OPTIONS = [
  { value: "native", label: "native" },
  { value: "gotify", label: "gotify" },
  { value: "telegram", label: "telegram" },
  { value: "ntfy", label: "ntfy" },
];

/** What each event means, as "…when <phrase>." — hub descriptions. */
const EVENT_PHRASES: Record<string, string> = {
  workflow_end: "a workflow finishes.",
  ralph_loop_end: "a ralph loop iteration ends.",
  mcp_server_error: "an MCP server errors.",
  agent_end: "the agent finishes a turn.",
  agent_settled: "the agent settles after streaming.",
  memory_consolidated: "a memory consolidation completes.",
  session_shutdown: "the session shuts down.",
  ask_user_prompt: "the agent asks you a question.",
  permission_request: "a permission prompt opens.",
  input_needed: "the agent is waiting on any prompt (covers tools that send no event of their own).",
};

/** One section per known event: enable + platform routing. */
const EVENT_SECTIONS = Object.keys(DEFAULT_CONFIG.events).map((event) => ({
  title: event,
  fields: [
    {
      key: `events.${event}.enabled`,
      type: "boolean" as const,
      label: "Enabled",
      description: `Send a notification when ${EVENT_PHRASES[event] ?? "the event fires."}`,
    },
    {
      key: `events.${event}.platforms`,
      type: "multiselect" as const,
      label: "Platforms",
      options: PLATFORM_OPTIONS,
      plainOptions: true,
      emptyLabel: "default platforms",
      description: "Where this event notifies. Empty uses the default platforms.",
    },
  ],
}));

// Registered with the unified settings hub. The canonical file
// (~/.unipi/config/notify/config.json) is exactly what this module already
// used, so switching to the engine is a no-op on disk.
//
// Absorbs the deleted legacy settings overlay: the event matrix lives
// in a dynamic "Events…" page, platform pages carry Setup wizard actions.
registerSettings({
  namespace: "notify",
  label: "Notify",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "General",
      fields: [
        {
          key: "defaultPlatforms",
          type: "multiselect",
          label: "Default platforms",
          options: PLATFORM_OPTIONS,
          plainOptions: true,
          emptyLabel: "none",
          description: "Used when an event lists no platforms of its own.",
        },
        { key: "native.enabled", type: "boolean", label: "Native desktop", description: "OS notifications through the desktop notification service." },
        { key: "native.suppressWhenFocused", type: "boolean", label: "Quiet when focused", description: "Hold native notifications while the terminal has focus." },
        { key: "recap.enabled", type: "boolean", label: "Recap", description: "Periodic digests of what happened while you were away." },
        { key: "recap.model", type: "model", label: "Recap model", emptyLabel: "inherit (session model)", capability: "text", emptyOption: "inherit (session model)", description: "Model that writes the recap; empty uses the session model." },
      ],
    },
    {
      title: "Silence & renotify",
      fields: [
        { key: "silenceAfterInput.enabled", type: "boolean", label: "Silence after input", description: "Hold notifications while you are typing." },
        { key: "silenceAfterInput.windowMs", type: "number", label: "Silence window", unit: "ms", min: 0, description: "How long after input notifications stay held." },
        {
          key: "silenceAfterInput.platforms",
          type: "multiselect",
          label: "Silence platforms",
          options: PLATFORM_OPTIONS,
          plainOptions: true,
          emptyLabel: "none",
          description: "Which platforms quiet down while you type.",
        },
        { key: "renotify.enabled", type: "boolean", label: "Renotify", description: "Repeat notifications that stay unresolved." },
        { key: "renotify.intervalMs", type: "number", label: "Renotify interval", unit: "ms", min: 0, description: "How often an unresolved notification repeats." },
        { key: "renotify.maxRepeats", type: "number", label: "Max repeats", min: 0, description: "Repeats before the notification is left alone." },
      ],
    },
    {
      title: "Events",
      description: "Event-by-event routing",
      fields: [
        {
          key: "events-page",
          type: "page",
          label: "Events…",
          description: "Turn each event into a notification and pick where it goes.",
          sections: EVENT_SECTIONS,
        },
        { key: "actions.test", type: "action", label: "Send test notification", description: "Sends on every enabled platform.", command: "unipi:notify-test" },
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
          description: "Self-hosted Gotify push server.",
          sections: [
            {
              title: "gotify",
              fields: [
                { key: "gotify.enabled", type: "boolean", label: "Enabled", description: "Deliver notifications through Gotify." },
                { key: "gotify.serverUrl", type: "string", label: "Server URL", emptyLabel: "https://gotify.example", description: "Base URL of your Gotify server." },
                { key: "gotify.appToken", type: "secret", label: "App token", emptyLabel: "unset", description: "Application token from the Gotify web UI." },
                { key: "gotify.priority", type: "number", label: "Priority", min: 0, max: 10, description: "Delivery priority (0–10)." },
              ],
            },
          ],
        },
        {
          key: "telegram",
          type: "page",
          label: "telegram",
          description: "Telegram bot delivery.",
          sections: [
            {
              title: "telegram",
              fields: [
                { key: "telegram.enabled", type: "boolean", label: "Enabled", description: "Deliver notifications through a Telegram bot." },
                { key: "telegram.botToken", type: "secret", label: "Bot token", emptyLabel: "unset", description: "Token from @BotFather." },
                { key: "telegram.chatId", type: "secret", label: "Chat ID", emptyLabel: "unset", description: "Chat the messages are delivered to." },
              ],
            },
          ],
        },
        {
          key: "ntfy",
          type: "page",
          label: "ntfy",
          description: "ntfy.sh push topics.",
          sections: [
            {
              title: "ntfy",
              fields: [
                { key: "ntfy.enabled", type: "boolean", label: "Enabled", description: "Deliver notifications by publishing to ntfy." },
                { key: "ntfy.serverUrl", type: "string", label: "Server", emptyLabel: "https://ntfy.sh", description: "ntfy server to publish to." },
                { key: "ntfy.topic", type: "string", label: "Topic", emptyLabel: "unset", description: "Topic name your devices subscribe to." },
                { key: "ntfy.token", type: "secret", label: "Access token", emptyLabel: "unset", description: "Token for protected topics." },
                { key: "ntfy.priority", type: "number", label: "Priority", min: 1, max: 5, description: "Delivery priority (1–5)." },
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
