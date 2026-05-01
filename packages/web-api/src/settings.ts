/**
 * @unipi/web-api — Settings storage
 *
 * Manages API keys and provider configuration.
 * Persists to ~/.unipi/config/web-api/auth.json and config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

/** Cache configuration */
export interface CacheSettings {
  enabled: boolean;
  ttlMs: number;
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
  cache: CacheSettings;
  smartFetch?: Partial<SmartFetchSettings>;
}

/** Default smart-fetch settings */
const DEFAULT_SMART_FETCH_SETTINGS: SmartFetchSettings = {
  browser: "chrome_145",
  os: "windows",
  maxChars: 50000,
  timeoutMs: 15000,
  batchConcurrency: 8,
  removeImages: false,
  includeReplies: "extractors",
};

/** Default configuration */
const DEFAULT_CONFIG: WebApiConfig = {
  providers: {
    duckduckgo: { enabled: true },
    "jina-search": { enabled: true },
    "jina-reader": { enabled: true },
    serpapi: { enabled: false },
    tavily: { enabled: false },
    firecrawl: { enabled: false },
    perplexity: { enabled: false },
    "llm-summarize": { enabled: true },
  },
  cache: {
    enabled: true,
    ttlMs: 3600000, // 1 hour
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
export function loadAuth(): WebApiAuth {
  try {
    const authPath = getAuthPath();
    if (fs.existsSync(authPath)) {
      const content = fs.readFileSync(authPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    console.error("[web-api] Failed to load auth:", error);
  }
  return {};
}

/**
 * Save API keys to auth.json.
 * @param auth - API keys object
 */
export function saveAuth(auth: WebApiAuth): void {
  ensureConfigDir();
  const authPath = getAuthPath();
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");
}

/**
 * Load configuration from config.json.
 * @returns Configuration object
 */
export function loadConfig(): WebApiConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as Partial<WebApiConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...config,
        providers: {
          ...DEFAULT_CONFIG.providers,
          ...config.providers,
        },
        cache: {
          ...DEFAULT_CONFIG.cache,
          ...config.cache,
        },
      };
    }
  } catch (error) {
    console.error("[web-api] Failed to load config:", error);
  }
  return DEFAULT_CONFIG;
}

/**
 * Save configuration to config.json.
 * @param config - Configuration object
 */
export function saveConfig(config: WebApiConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
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
  const auth = loadAuth();
  delete auth[providerId];
  saveAuth(auth);
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
 * Get cache settings.
 * @returns Cache configuration
 */
export function getCacheSettings(): CacheSettings {
  const config = loadConfig();
  return config.cache;
}

/**
 * Update cache settings.
 * @param cache - New cache settings
 */
export function updateCacheSettings(cache: Partial<CacheSettings>): void {
  const config = loadConfig();
  config.cache = {
    ...config.cache,
    ...cache,
  };
  saveConfig(config);
}

/**
 * Validate API key format (basic validation).
 * @param providerId - Provider ID
 * @param apiKey - API key to validate
 * @returns true if format looks valid
 */
export function validateApiKeyFormat(providerId: string, apiKey: string): boolean {
  if (!apiKey || apiKey.trim().length === 0) {
    return false;
  }

  // Provider-specific format checks
  switch (providerId) {
    case "serpapi":
      // SerpAPI keys are typically 64 characters
      return apiKey.length >= 32;
    case "tavily":
      // Tavily keys start with "tvly-"
      return apiKey.startsWith("tvly-") && apiKey.length >= 10;
    case "firecrawl":
      // Firecrawl keys are typically longer
      return apiKey.length >= 20;
    case "perplexity":
      // Perplexity keys are typically longer
      return apiKey.length >= 20;
    case "jina-search":
    case "jina-reader":
      // Jina keys are typically longer
      return apiKey.length >= 10;
    default:
      // Generic validation
      return apiKey.length >= 8;
  }
}

/**
 * Load smart-fetch settings.
 * Merges defaults with saved config.
 * @returns Smart-fetch settings
 */
export function loadSmartFetchSettings(): SmartFetchSettings {
  const config = loadConfig();
  return {
    ...DEFAULT_SMART_FETCH_SETTINGS,
    ...config.smartFetch,
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
