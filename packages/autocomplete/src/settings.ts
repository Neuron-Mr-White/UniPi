/**
 * @pi-unipi/command-enchantment — Settings
 *
 * Manages the autocompleteEnhanced toggle.
 * Persists to ~/.unipi/config/command-enchantment/config.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Config structure */
export interface CommandEnchantmentConfig {
  autocompleteEnhanced: boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: CommandEnchantmentConfig = {
  autocompleteEnhanced: true,
};

/** Config directory path */
function getConfigDir(): string {
  return path.join(os.homedir(), ".unipi", "config", "command-enchantment");
}

/** Config file path */
function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

/** Ensure config directory exists */
function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load configuration from disk.
 * Returns defaults if file doesn't exist or is malformed.
 */
export function loadConfig(): CommandEnchantmentConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as Partial<CommandEnchantmentConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...config,
      };
    }
  } catch {
    // Silently ignore — config load failure falls back to defaults.
  }
  return DEFAULT_CONFIG;
}

/**
 * Save configuration to disk.
 */
export function saveConfig(config: CommandEnchantmentConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Check if autocomplete enhancement is enabled.
 */
export function isAutocompleteEnhanced(): boolean {
  return loadConfig().autocompleteEnhanced;
}

/**
 * Enable or disable autocomplete enhancement.
 */
export function setAutocompleteEnhanced(enabled: boolean): void {
  const config = loadConfig();
  config.autocompleteEnhanced = enabled;
  saveConfig(config);
}
