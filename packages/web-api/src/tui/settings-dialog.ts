/**
 * @unipi/web-api — Settings TUI dialog
 *
 * Interactive TUI for API key management.
 * Uses pi's TUI components for provider selection and key input.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
export async function showSettingsDialog(pi: ExtensionAPI): Promise<void> {
  let running = true;

  while (running) {
    const options = getProviderOptions();

    // Add exit option
    options.push({
      label: "← Back",
      value: "__exit__",
      description: "Exit settings",
    });

    // Show provider list
    const selected = await pi.ui.select({
      title: "Web API Settings",
      message: "Select a provider to configure:",
      options,
    });

    if (!selected || selected === "__exit__") {
      running = false;
      continue;
    }

    // Show provider configuration
    await configureProvider(pi, selected);
  }
}

/**
 * Configure a specific provider.
 */
async function configureProvider(
  pi: ExtensionAPI,
  providerId: string
): Promise<void> {
  const provider = registry.getProvider(providerId);
  if (!provider) {
    await pi.ui.notify({
      message: `Provider "${providerId}" not found`,
      level: "error",
    });
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

  const selected = await pi.ui.select({
    title: `Configure ${provider.name}`,
    message: `Capabilities: ${provider.capabilities.join(", ")}`,
    options,
  });

  switch (selected) {
    case "__toggle__":
      setProviderEnabled(providerId, !enabled);
      await pi.ui.notify({
        message: `${provider.name} ${!enabled ? "enabled" : "disabled"}`,
        level: "success",
      });
      break;

    case "__add_key__":
    case "__update_key__":
      await inputApiKey(pi, providerId, provider.name);
      break;

    case "__remove_key__":
      removeApiKey(providerId);
      await pi.ui.notify({
        message: `API key removed for ${provider.name}`,
        level: "success",
      });
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
  pi: ExtensionAPI,
  providerId: string,
  providerName: string
): Promise<void> {
  const apiKey = await pi.ui.input({
    title: `API Key for ${providerName}`,
    message: `Enter API key (env: ${registry.getProvider(providerId)?.apiKeyEnv || "N/A"}):`,
    placeholder: "sk-...",
    validate: async (value: string) => {
      if (!value || value.trim().length === 0) {
        return "API key cannot be empty";
      }
      if (!validateApiKeyFormat(providerId, value)) {
        return "API key format looks invalid";
      }
      return null;
    },
  });

  if (apiKey) {
    setApiKey(providerId, apiKey);
    await pi.ui.notify({
      message: `API key saved for ${providerName}`,
      level: "success",
    });
  }
}
