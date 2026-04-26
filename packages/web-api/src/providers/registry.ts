/**
 * @unipi/web-api — Provider registry
 *
 * Registry for managing web providers.
 * Handles registration, retrieval, and ranked selection.
 */

import type {
  WebProvider,
  WebCapability,
  ProviderConfig,
} from "./base.js";

/**
 * ProviderRegistry manages all registered web providers.
 *
 * Provides methods to:
 * - Register providers
 * - Retrieve providers by ID
 * - Get providers for a specific capability
 * - Get ranked providers for smart selection
 */
export class ProviderRegistry {
  private providers: Map<string, WebProvider> = new Map();

  /**
   * Register a provider.
   * @param provider - Provider to register
   */
  register(provider: WebProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  /**
   * Unregister a provider.
   * @param providerId - Provider ID to unregister
   */
  unregister(providerId: string): void {
    this.providers.delete(providerId);
  }

  /**
   * Get a provider by ID.
   * @param providerId - Provider ID
   * @returns Provider or undefined
   */
  getProvider(providerId: string): WebProvider | undefined {
    return this.providers.get(providerId);
  }

  /**
   * Get all registered providers.
   * @returns Array of all providers
   */
  getAllProviders(): WebProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get providers that support a specific capability.
   * @param capability - Capability to filter by
   * @returns Array of providers with the capability
   */
  getProvidersForCapability(capability: WebCapability): WebProvider[] {
    return this.getAllProviders().filter((p) =>
      p.capabilities.includes(capability)
    );
  }

  /**
   * Get ranked providers for a specific capability.
   * Sorted by ranking (lower = better/simpler/cheaper).
   * @param capability - Capability to rank by
   * @returns Array of providers sorted by ranking
   */
  getRankedProviders(capability: WebCapability): WebProvider[] {
    return this.getProvidersForCapability(capability)
      .filter((p) => p.ranking[capability] > 0)
      .sort((a, b) => a.ranking[capability] - b.ranking[capability]);
  }

  /**
   * Get the best provider for a capability (lowest rank).
   * @param capability - Capability to find best provider for
   * @returns Best provider or undefined
   */
  getBestProvider(capability: WebCapability): WebProvider | undefined {
    const ranked = this.getRankedProviders(capability);
    return ranked[0];
  }

  /**
   * Get a provider by rank for a capability.
   * @param capability - Capability to search
   * @param rank - Desired rank (1-based)
   * @returns Provider at that rank or undefined
   */
  getProviderByRank(capability: WebCapability, rank: number): WebProvider | undefined {
    const ranked = this.getRankedProviders(capability);
    return ranked.find((p) => p.ranking[capability] === rank);
  }

  /**
   * Get enabled providers based on configuration.
   * @param configMap - Map of provider ID to config
   * @returns Array of enabled providers
   */
  getEnabledProviders(configMap: Map<string, ProviderConfig>): WebProvider[] {
    return this.getAllProviders().filter((p) => {
      const config = configMap.get(p.id);
      return config?.enabled !== false;
    });
  }

  /**
   * Get provider count.
   * @returns Number of registered providers
   */
  get count(): number {
    return this.providers.size;
  }
}

/** Singleton registry instance */
export const registry = new ProviderRegistry();
