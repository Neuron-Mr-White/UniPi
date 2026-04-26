/**
 * @unipi/web-api — Provider selector TUI component
 *
 * Displays provider list with status indicators for API key management.
 */

import type { WebProvider } from "../providers/base.js";
import { registry } from "../providers/registry.js";
import { getApiKey, isProviderEnabled } from "../settings.js";

/** Provider status */
export interface ProviderStatus {
  provider: WebProvider;
  configured: boolean;
  enabled: boolean;
  hasApiKey: boolean;
}

/**
 * Get status of all providers.
 */
export function getProviderStatuses(): ProviderStatus[] {
  const providers = registry.getAllProviders();

  return providers.map((provider) => {
    const hasApiKey = provider.requiresApiKey
      ? !!getApiKey(provider.id)
      : true;
    const enabled = isProviderEnabled(provider.id);

    return {
      provider,
      configured: hasApiKey && enabled,
      enabled,
      hasApiKey,
    };
  });
}

/**
 * Format provider status for display.
 */
export function formatProviderStatus(status: ProviderStatus): string {
  const icon = status.configured ? "✓" : "✗";
  const name = status.provider.name.padEnd(20);
  const capabilities = status.provider.capabilities.join(", ");
  const apiKeyStatus = status.provider.requiresApiKey
    ? status.hasApiKey
      ? "API key configured"
      : "API key required"
    : "No API key needed";

  return `${icon} ${name} ${capabilities.padEnd(30)} ${apiKeyStatus}`;
}

/**
 * Get provider selection options for TUI.
 */
export function getProviderOptions(): Array<{
  label: string;
  value: string;
  description: string;
}> {
  const statuses = getProviderStatuses();

  return statuses.map((status) => ({
    label: formatProviderStatus(status),
    value: status.provider.id,
    description: `${status.provider.name} - ${status.provider.capabilities.join(", ")}`,
  }));
}
