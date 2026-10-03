/**
 * @unipi/web-api — Settings storage
 *
 * Manages API keys and provider configuration.
 * Persists to ~/.unipi/config/web-api/auth.json and config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DEFAULT_BROWSER,
  DEFAULT_OS,
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BATCH_CONCURRENCY,
  DEFAULT_REMOVE_IMAGES,
  DEFAULT_INCLUDE_REPLIES,
} from "./engine/constants.js";
import { BROWSER_PROFILES } from "./engine/profiles.js";
import { getField, getSettings, registerSettings, setField, setSettings, settingsLayers } from "@pi-unipi/core";

/** Auth storage structure (API keys) */
export interface WebApiAuth {
  [providerId: string]: string;
}

/** Provider configuration */
export interface ProviderSettings {
  enabled: boolean;
  apiKey?: string;
  [key: string]: unknown;
}

/** Smart-fetch default settings */
export interface SmartFetchSettings {
  /** TLS fingerprint browser profile */
  browser: string;
  /** OS fingerprint */
  os: string;
  /** Maximum content characters */
  maxChars: number;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Batch concurrency */
  batchConcurrency: number;
  /** Strip image references */
  removeImages: boolean;
  /** Include replies/comments */
  includeReplies: boolean | "extractors";
}

/** Config storage structure */
export interface WebApiConfig {
  providers: Record<string, ProviderSettings>;
  smartFetch?: Partial<SmartFetchSettings>;
}

/** Default smart-fetch settings — values from engine/constants.ts */
const DEFAULT_SMART_FETCH_SETTINGS: SmartFetchSettings = {
  browser: DEFAULT_BROWSER,
  os: DEFAULT_OS,
  maxChars: DEFAULT_MAX_CHARS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  batchConcurrency: DEFAULT_BATCH_CONCURRENCY,
  removeImages: DEFAULT_REMOVE_IMAGES,
  includeReplies: DEFAULT_INCLUDE_REPLIES,
};

/** Default configuration */
const DEFAULT_CONFIG: WebApiConfig = {
  providers: {
    wigolo: { enabled: true },
    duckduckgo: { enabled: true },
    "jina-search": { enabled: true },
    "jina-reader": { enabled: true },
    serpapi: { enabled: false },
    tavily: { enabled: false },
    firecrawl: { enabled: false },
    perplexity: { enabled: false },
  },
  smartFetch: {},
};

/**
 * Get the config directory path.
 */
function getConfigDir(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, ".unipi", "config", "web-api");
}

/**
 * Get the auth file path.
 */
function getAuthPath(): string {
  return path.join(getConfigDir(), "auth.json");
}

/**
 * Get the config file path.
 */
function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

/**
 * Ensure config directory exists.
 */
function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load API keys from auth.json.
 * @returns API keys object
 */
/** Provider keys as stored in the engine (providers.<id>.apiKey). */
function engineAuth(): WebApiAuth {
  const cfg = getSettings("web-api", process.cwd()) as { providers?: Record<string, { apiKey?: string }> };
  const out: WebApiAuth = {};
  for (const [id, p] of Object.entries(cfg.providers ?? {})) {
    if (p && typeof p.apiKey === "string" && p.apiKey.length > 0) out[id] = p.apiKey;
  }
  return out;
}

/** One-time import of the legacy auth.json into the engine namespace. */
function importLegacyAuth(): void {
  if (Object.keys(engineAuth()).length > 0) return;
  try {
    const authPath = getAuthPath();
    if (!fs.existsSync(authPath)) return;
    const legacy = JSON.parse(fs.readFileSync(authPath, "utf-8")) as WebApiAuth;
    let patch: Record<string, unknown> = {};
    for (const [id, key] of Object.entries(legacy)) patch = setField(patch, `providers.${id}.apiKey`, key);
    if (Object.keys(patch).length > 0) setSettings("web-api", patch, "global", process.cwd());
  } catch {
    // Legacy unreadable — nothing to import.
  }
}

export function loadAuth(): WebApiAuth {
  importLegacyAuth();
  return engineAuth();
}

/**
 * Save API keys to auth.json.
 * @param auth - API keys object
 */
export function saveAuth(auth: WebApiAuth): void {
  // Keys ride the engine as providers.<id>.apiKey (hub pages edit them too).
  let patch: Record<string, unknown> = {};
  for (const [id, key] of Object.entries(auth)) patch = setField(patch, `providers.${id}.apiKey`, key);
  if (Object.keys(patch).length > 0) setSettings("web-api", patch, "global", process.cwd());
}

/** One-line identity per provider — page description in the hub. */
const PROVIDER_BLURBS: Record<string, string> = {
  wigolo: "Local web engine: multi-engine search and tiered fetch. Needs npx wigolo init, no key.",
  duckduckgo: "Keyless web search.",
  "jina-search": "Keyless web search via Jina.",
  "jina-reader": "Keyless URL-to-markdown reader.",
  serpapi: "Google results API. Paid key.",
  tavily: "Research-oriented search API. Paid key.",
  firecrawl: "Scraping and crawl API. Paid key.",
  perplexity: "Search and summarize via Perplexity. Paid key.",
};

// Registered with the unified settings hub. Provider auth rides the engine
// (providers.<id>.apiKey secret fields, editable via per-provider pages);
// legacy auth.json is imported once on first read.
registerSettings({
  namespace: "web-api",
  label: "Web API",
  defaults: DEFAULT_CONFIG as unknown as Record<string, unknown>,
  schema: [
    {
      title: "Providers",
      description: "Per-provider pages — enable + API key (tavily, serpapi, …)",
      fields: Object.keys(DEFAULT_CONFIG.providers).map((id) => ({
        key: `providers.${id}` as string,
        type: "page" as const,
        label: id,
        description: PROVIDER_BLURBS[id] ?? "Web provider.",
        sections: [
          {
            title: id,
            fields: [
              { key: `providers.${id}.enabled` as string, type: "boolean" as const, label: "Enabled", description: "Let this provider serve requests of its kind." },
              {
                key: `providers.${id}.apiKey` as string,
                type: "secret" as const,
                label: "API key",
                emptyLabel: "unset (public access)",
                description: "Key sent with every request to this provider.",
              },
            ],
          },
        ],
      })),
    },
    {
      title: "Smart fetch",
      advanced: true,
      fields: [
        {
          key: "smartFetch.browser",
          type: "enum",
          label: "Browser profile",
          plainOptions: true,
          description: "Browser identity the fetch engine presents to sites; newest first.",
          options: [...BROWSER_PROFILES].reverse(),
        },
        {
          key: "smartFetch.includeReplies",
          type: "enum",
          label: "Include replies",
          description: "Whether comment and reply sections are fetched and kept.",
          options: [
            { value: "true", label: "yes", description: "fetch and include comment replies" },
            { value: "false", label: "no", description: "main content only" },
            { value: "extractors", label: "extractors (default)", description: "each extractor decides per site" },
          ],
        },
        { key: "smartFetch.maxChars", type: "number", label: "Max chars", min: 1000, description: "Content cap per URL before truncation." },
        { key: "smartFetch.timeoutMs", type: "number", label: "Timeout", unit: "ms", min: 1000, description: "Per-request timeout." },
        { key: "smartFetch.removeImages", type: "boolean", label: "Remove images", description: "Strip image references from fetched content." },
        { key: "cache.clear", type: "action", label: "Clear web cache…", description: "Drop every cached response (with a confirm step).", command: "unipi:web-cache-clear" },
      ],
    },
  ],
});

/**
 * Load configuration (engine-layered).
 * @returns Configuration object
 */
export function loadConfig(): WebApiConfig {
  try {
    const config = getSettings("web-api", process.cwd()) as Partial<WebApiConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...config,
      providers: {
        ...DEFAULT_CONFIG.providers,
        ...config.providers,
      },
    };
  } catch {
    // Silently ignore — config load failure falls back to defaults.
  }
  return DEFAULT_CONFIG;
}

/**
 * Save configuration to config.json.
 * @param config - Configuration object
 */
export function saveConfig(config: WebApiConfig): void {
  setSettings("web-api", config as unknown as Record<string, unknown>, "global", process.cwd());
}

/**
 * Get API key for a provider.
 * @param providerId - Provider ID
 * @returns API key or undefined
 */
export function getApiKey(providerId: string): string | undefined {
  const auth = loadAuth();
  return auth[providerId];
}

/**
 * Set API key for a provider.
 * @param providerId - Provider ID
 * @param apiKey - API key
 */
export function setApiKey(providerId: string, apiKey: string): void {
  const auth = loadAuth();
  auth[providerId] = apiKey;
  saveAuth(auth);
}

/**
 * Remove API key for a provider.
 * @param providerId - Provider ID
 */
export function removeApiKey(providerId: string): void {
  // Engine merge can't delete — clearing to "" makes the key read as unset.
  setSettings(
    "web-api",
    setField({}, `providers.${providerId}.apiKey`, ""),
    "global",
    process.cwd(),
  );
}

/**
 * Check if a provider is enabled.
 * @param providerId - Provider ID
 * @returns true if enabled
 */
export function isProviderEnabled(providerId: string): boolean {
  const config = loadConfig();
  return config.providers[providerId]?.enabled !== false;
}

/**
 * Enable or disable a provider.
 * @param providerId - Provider ID
 * @param enabled - Whether to enable
 */
export function setProviderEnabled(providerId: string, enabled: boolean): void {
  const config = loadConfig();
  if (!config.providers[providerId]) {
    config.providers[providerId] = { enabled };
  } else {
    config.providers[providerId].enabled = enabled;
  }
  saveConfig(config);
}




/**
 * Load smart-fetch settings.
 * Merges defaults with saved config.
 * @returns Smart-fetch settings
 */
export function loadSmartFetchSettings(): SmartFetchSettings {
  const config = loadConfig();
  // The hub enum writes strings; coerce back to the boolean the fetchers use.
  const stored = config.smartFetch as { includeReplies?: unknown } | undefined;
  const includeReplies = stored?.includeReplies;
  const normalized =
    includeReplies === "true" ? true : includeReplies === "false" ? false : undefined;
  return {
    ...DEFAULT_SMART_FETCH_SETTINGS,
    ...config.smartFetch,
    ...(normalized !== undefined ? { includeReplies: normalized as SmartFetchSettings["includeReplies"] } : {}),
  };
}

/**
 * Save smart-fetch settings.
 * @param settings - Partial settings to save
 */
export function saveSmartFetchSettings(settings: Partial<SmartFetchSettings>): void {
  const config = loadConfig();
  config.smartFetch = {
    ...config.smartFetch,
    ...settings,
  };
  saveConfig(config);
}

/**
 * Reset smart-fetch settings to defaults.
 */
export function resetSmartFetchSettings(): void {
  const config = loadConfig();
  config.smartFetch = {};
  saveConfig(config);
}
