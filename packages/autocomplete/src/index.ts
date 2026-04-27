/**
 * @pi-unipi/command-enchantment — Extension Entry Point
 *
 * Registers an enhanced autocomplete provider for /unipi:* commands.
 * Intercepts slash command suggestions and returns colored, sorted,
 * package-grouped items with descriptions.
 *
 * Toggle via: ~/.unipi/config/command-enchantment/config.json
 * Setting: autocompleteEnhanced (default: true)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createEnchantedProvider } from "./provider.js";
import { isAutocompleteEnhanced } from "./settings.js";

export default function commandEnchantment(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    // Check if enhancement is enabled
    const enabled = isAutocompleteEnhanced();

    if (!enabled) {
      // When disabled, don't register the provider at all — pure passthrough
      return;
    }

    // Register the autocomplete provider that wraps the base provider
    ctx.ui.addAutocompleteProvider((current) =>
      createEnchantedProvider(current, enabled),
    );
  });
}
