/**
 * @pi-unipi/image — Bridge pi's chat providers into pi-ai's images collection
 *
 * pi-ai ships exactly one image provider (openrouter), so out of the box image
 * generation demands an OpenRouter account even when the user has half a dozen
 * other providers configured. pi's own registry knows those providers and their
 * credentials, so we re-register each one as an *images* provider backed by the
 * single generic OpenAI-compatible adapter.
 *
 * The result: any OpenAI-compatible provider the user configures in pi can
 * generate and edit images with no image-specific setup, and no per-provider
 * code here.
 *
 * ## Why capability detection stays heuristic
 * pi's model registry cannot tell us which models emit images.
 * `provider-composer.ts` builds each registered model from an explicit field
 * list — `{id, name, api, provider, baseUrl, reasoning, input, cost,
 * contextWindow, maxTokens, headers, compat}` — so an extension that attaches
 * `output: ["image"]` has it silently dropped. `ProviderModelConfig` has no
 * `output` field at all. Hence `looksLikeImageGenerator()` name-matching, plus
 * explicit "provider/model-id" entry as the always-available escape hatch.
 */

import * as imagesApi from "./openai-images-api.js";
import {
  getImagesModels,
  listRegistryImageGenModels,
  type ChatModelRegistry,
  type ImageGenModel,
} from "./models.js";

/** pi-ai's `createImagesProvider`, kept structural to avoid type coupling. */
interface CreateImagesProviderFn {
  (input: {
    id: string;
    name?: string;
    auth: unknown;
    models: readonly ImageGenModel[];
    api: unknown;
  }): unknown;
}

/** The subset of a registry provider we need. */
interface ProviderLike {
  id: string;
  name?: string;
  baseUrl?: string;
}

let registered = false;

/** Reset registration state. Test-only. */
export function __resetRegistrationForTests(): void {
  registered = false;
}

/**
 * Group discovered generator models by provider, attaching the provider's
 * baseUrl so the adapter knows where to POST.
 */
export function groupModelsByProvider(
  models: ImageGenModel[],
  baseUrlFor: (provider: string) => string | undefined,
): Map<string, { baseUrl: string; models: ImageGenModel[] }> {
  const grouped = new Map<string, { baseUrl: string; models: ImageGenModel[] }>();

  for (const model of models) {
    const baseUrl = model.baseUrl ?? baseUrlFor(model.provider);
    // Without an endpoint the adapter cannot issue a request; skip rather than
    // register a provider that is guaranteed to fail.
    if (!baseUrl) continue;

    let entry = grouped.get(model.provider);
    if (!entry) {
      entry = { baseUrl, models: [] };
      grouped.set(model.provider, entry);
    }
    entry.models.push({ ...model, baseUrl });
  }

  return grouped;
}

/** Read a provider's baseUrl out of pi's registry. */
function providerBaseUrlLookup(
  registry: ChatModelRegistry,
): (provider: string) => string | undefined {
  const cache = new Map<string, string | undefined>();

  return (provider: string) => {
    if (cache.has(provider)) return cache.get(provider);

    let baseUrl: string | undefined;
    try {
      const models = (registry.getAvailable?.() ?? registry.getAll()) as Array<{
        provider?: string;
        baseUrl?: string;
      }>;
      baseUrl = models.find((m) => m?.provider === provider && m.baseUrl)?.baseUrl;
    } catch {
      baseUrl = undefined;
    }

    cache.set(provider, baseUrl);
    return baseUrl;
  };
}

/**
 * Register every pi provider that looks capable of image generation into
 * pi-ai's images collection.
 *
 * Idempotent and best-effort: a failure here must never break the extension,
 * since generation still works for pi-ai's built-in providers.
 *
 * @returns the provider ids registered.
 */
export async function registerRegistryImageProviders(
  registry: ChatModelRegistry | undefined,
  options?: { force?: boolean },
): Promise<string[]> {
  if (!registry) return [];
  if (registered && !options?.force) return [];

  const images = await getImagesModels();
  if (!images) return [];

  // `setProvider` is on MutableImagesModels; the built-in collection provides
  // it, but guard in case a future pi-ai hands back an immutable one.
  const mutable = images as unknown as {
    setProvider?: (provider: unknown) => void;
    getProvider?: (id: string) => unknown;
  };
  if (typeof mutable.setProvider !== "function") return [];

  let createImagesProvider: CreateImagesProviderFn;
  try {
    const mod = (await import("@earendil-works/pi-ai")) as unknown as {
      createImagesProvider?: CreateImagesProviderFn;
    };
    if (typeof mod.createImagesProvider !== "function") return [];
    createImagesProvider = mod.createImagesProvider;
  } catch {
    return [];
  }

  const discovered = listRegistryImageGenModels(registry);
  if (discovered.length === 0) {
    registered = true;
    return [];
  }

  const grouped = groupModelsByProvider(discovered, providerBaseUrlLookup(registry));
  const added: string[] = [];

  for (const [providerId, { models }] of grouped) {
    // Never shadow a provider pi-ai serves natively — its own implementation
    // is better informed than our generic adapter.
    try {
      if (mutable.getProvider?.(providerId)) continue;
    } catch {
      // Treat a lookup failure as "not present" and attempt registration.
    }

    try {
      const provider = createImagesProvider({
        id: providerId,
        name: providerId,
        models,
        api: imagesApi,
        auth: {
          apiKey: {
            name: `${providerId} API key`,
            // Resolve through pi's own auth storage so the user never logs in
            // twice. `resolve` MUST return an AuthResult (`{ auth: {...} }`);
            // returning a bare key fails silently at request time.
            resolve: async () => {
              const key = await resolveProviderKey(registry, providerId);
              return key ? { auth: { apiKey: key }, source: `pi:${providerId}` } : undefined;
            },
          },
        },
      });

      mutable.setProvider(provider);
      added.push(providerId);
    } catch {
      // One bad provider must not stop the rest.
    }
  }

  registered = true;
  return added;
}

/** Resolve a provider key from pi's auth storage, falling back to the env. */
async function resolveProviderKey(
  registry: ChatModelRegistry,
  provider: string,
): Promise<string | undefined> {
  try {
    const key = await registry.getApiKeyForProvider?.(provider);
    if (key) return key;
  } catch {
    // Fall through to the environment.
  }
  const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  return process.env[envName] || undefined;
}

/** Provider ids pi-ai can currently generate with, after registration. */
export function registeredProviderIds(images: {
  getProviders?: () => ReadonlyArray<{ id: string }>;
}): string[] {
  try {
    return (images.getProviders?.() ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}
