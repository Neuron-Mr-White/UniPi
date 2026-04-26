/**
 * @unipi/web-api — Settings TUI dialog
 *
 * Interactive TUI for API key management.
 * Uses pi's TUI components for provider selection and key input.
 */

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { registry } from "../providers/registry.js";
import {
  getApiKey,
  setApiKey,
  removeApiKey,
  isProviderEnabled,
  setProviderEnabled,
  validateApiKeyFormat,
} from "../settings.js";
import { getProviderOptions, getProviderStatuses } from "./provider-selector.js";

/**
 * Show settings dialog.
 * This is the main entry point for /unipi:web-settings command.
 */
export async function showSettingsDialog(ctx: ExtensionCommandContext): Promise<void> {
  let running = true;
  let lastSelected: string | undefined;

  while (running) {
    const options = getProviderOptions();

    // Add exit option
    options.push({
      label: "← Back",
      value: "__exit__",
      description: "Exit settings",
    });

    // Move last selected provider to top of list for quick re-entry
    if (lastSelected && lastSelected !== "__exit__") {
      const idx = options.findIndex(o => o.value === lastSelected);
      if (idx > 0) {
        const [item] = options.splice(idx, 1);
        options.unshift(item);
      }
    }

    // Show provider list
    const labels = options.map(o => o.value === "__exit__" ? o.label : `${o.label} — ${o.description}`);
    const selected = await ctx.ui.select(
      "Web API Settings",
      labels,
    );
    // Map label back to value
    const selectedOpt = options.find(o => {
      const full = o.value === "__exit__" ? o.label : `${o.label} — ${o.description}`;
      return full === selected;
    });
    const selectedValue = selectedOpt?.value;

    if (!selectedValue || selectedValue === "__exit__") {
      running = false;
      continue;
    }

    lastSelected = selectedValue;

    // Show provider configuration
    await configureProvider(ctx, selectedValue);
  }
}

/**
 * Configure a specific provider.
 */
async function configureProvider(
  ctx: ExtensionCommandContext,
  providerId: string
): Promise<void> {
  const provider = registry.getProvider(providerId);
  if (!provider) {
    ctx.ui.notify(
      `Provider "${providerId}" not found`,
      "error",
    );
    return;
  }

  const hasApiKey = !!getApiKey(providerId);
  const enabled = isProviderEnabled(providerId);

  const options = [];

  // Toggle enable/disable
  options.push({
    label: enabled ? "✓ Enabled" : "✗ Disabled",
    value: "__toggle__",
    description: enabled
      ? "Click to disable this provider"
      : "Click to enable this provider",
  });

  // API key management (only for providers that require it)
  if (provider.requiresApiKey) {
    if (hasApiKey) {
      options.push({
        label: "🔑 Update API Key",
        value: "__update_key__",
        description: "Update the API key",
      });
      options.push({
        label: "🗑️ Remove API Key",
        value: "__remove_key__",
        description: "Remove the stored API key",
      });
    } else {
      options.push({
        label: "🔑 Add API Key",
        value: "__add_key__",
        description: "Add an API key for this provider",
      });
    }
  }

  // Back option
  options.push({
    label: "← Back",
    value: "__back__",
    description: "Return to provider list",
  });

  const labels = options.map(o => `${o.label} — ${o.description}`);
  const selected = await ctx.ui.select(
    `Configure ${provider.name} (${provider.capabilities.join(", ")})`,
    labels,
  );
  const selectedOpt = options.find(o => `${o.label} — ${o.description}` === selected);
  const selectedValue = selectedOpt?.value;

  switch (selectedValue) {
    case "__toggle__":
      setProviderEnabled(providerId, !enabled);
      ctx.ui.notify(
        `${provider.name} ${!enabled ? "enabled" : "disabled"}`,
        "info",
      );
      break;

    case "__add_key__":
    case "__update_key__":
      await inputApiKey(ctx, providerId, provider.name);
      break;

    case "__remove_key__":
      removeApiKey(providerId);
      ctx.ui.notify(
        `API key removed for ${provider.name}`,
        "info",
      );
      break;

    case "__back__":
    default:
      break;
  }
}

/**
 * Input API key for a provider.
 */
async function inputApiKey(
  ctx: ExtensionCommandContext,
  providerId: string,
  providerName: string
): Promise<void> {
  const envHint = registry.getProvider(providerId)?.apiKeyEnv || "N/A";
  const apiKey = await ctx.ui.input(
    `API Key for ${providerName} (env: ${envHint})`,
    "sk-...",
  );

  if (apiKey) {
    setApiKey(providerId, apiKey);
    // Auto-enable provider on successful key input
    if (!isProviderEnabled(providerId)) {
      setProviderEnabled(providerId, true);
    }
    ctx.ui.notify(
      `API key saved for ${providerName} — enabled`,
      "info",
    );
  }
}
