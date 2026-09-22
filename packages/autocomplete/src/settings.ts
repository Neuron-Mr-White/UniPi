/**
 * @pi-unipi/command-enchantment — Settings
 *
 * Registered with the core settings engine; reads/writes the canonical
 * ~/.unipi/config/command-enchantment/config.json via getSettings/setSettings.
 */

import { getSettings, registerSettings, setSettings } from "@pi-unipi/core";

/** Config structure */
export interface CommandEnchantmentConfig {
  autocompleteEnhanced: boolean;
}

/** Default configuration */
const DEFAULT_CONFIG: CommandEnchantmentConfig = {
  autocompleteEnhanced: true,
};

registerSettings({
  namespace: "command-enchantment",
  label: "Command Enchantment",
  defaults: { ...DEFAULT_CONFIG },
  schema: [
    {
      title: "Autocomplete",
      fields: [
        {
          key: "autocompleteEnhanced",
          type: "boolean",
          label: "Enhanced autocomplete",
          description: "Fuzzy /unipi:* command suggestions",
        },
      ],
    },
  ],
});

/** Load configuration (defaults ⊕ global ⊕ project). */
export function loadConfig(): CommandEnchantmentConfig {
  const raw = getSettings("command-enchantment", process.cwd());
  return {
    autocompleteEnhanced:
      typeof raw.autocompleteEnhanced === "boolean" ? raw.autocompleteEnhanced : DEFAULT_CONFIG.autocompleteEnhanced,
  };
}

/** Save configuration to the global scope. */
export function saveConfig(config: CommandEnchantmentConfig): void {
  setSettings("command-enchantment", { ...config }, "global", process.cwd());
}

/** Check if autocomplete enhancement is enabled. */
export function isAutocompleteEnhanced(): boolean {
  return loadConfig().autocompleteEnhanced;
}

/** Enable or disable autocomplete enhancement. */
export function setAutocompleteEnhanced(enabled: boolean): void {
  saveConfig({ ...loadConfig(), autocompleteEnhanced: enabled });
}
