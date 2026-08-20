/**
 * @unipi/web-api — Provider registry
 *
 * Registry for managing web providers.
 * Handles registration, retrieval, and ranked selection.
 */

import type {
  WebProvider,
  WebCapability,
} from "./base.js";

/**
 * ProviderRegistry manages all registered web providers.
 */
export class ProviderRegistry {
  private providers: Map<string, WebProvider> = new Map();

  register(provider: WebProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): WebProvider | undefined {
    return this.providers.get(providerId);
  }

  getAllProviders(): WebProvider[] {
    return Array.from(this.providers.values());
  }

  getProvidersForCapability(capability: WebCapability): WebProvider[] {
    return this.getAllProviders().filter((p) =>
      p.capabilities.includes(capability)
    );
  }

  getRankedProviders(capability: WebCapability): WebProvider[] {
    return this.getProvidersForCapability(capability)
      .filter((p) => p.ranking[capability] > 0)
      .sort((a, b) => a.ranking[capability] - b.ranking[capability]);
  }
}

/** Singleton registry instance */
export const registry = new ProviderRegistry();
