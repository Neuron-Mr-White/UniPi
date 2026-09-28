/**
 * @pi-unipi/utility — image model catalog, routing and keys
 *
 * Catalog (merged into the shared model cache with real modalities):
 *   - OpenRouter's image models (public /models?output_modalities=image),
 *     refreshed at most daily into ~/.unipi/config/image-models-cache.json
 *   - a short list of fal models (listed when a fal key is available)
 *   - pi's chat models already in the cache (vision = input includes image)
 *
 * Routing a "provider/model-id" reference:
 *   openrouter/… → OpenRouter chat+modalities   key: settings → pi login → OPENROUTER_API_KEY
 *   fal/…        → fal.run                       key: settings → FAL_KEY / FAL_API_KEY
 *   <other>/…    → that pi provider's baseUrl, OpenAI images shape, pi's key for it
 *   custom endpoint set in settings → that endpoint, model id as typed, its key
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readModelCache, type CachedModel, type Modality } from "@pi-unipi/core";
import type { EndpointSettings, ImageApi, ImageConfig } from "./settings.js";

export interface ModelRegistryLike {
  find(provider: string, id: string): unknown;
  getAll(): unknown[];
  getAvailable?(): unknown[];
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

export function splitRef(ref: string): { provider: string; id: string } | null {
  const t = ref.trim();
  const slash = t.indexOf("/");
  return slash > 0 && slash < t.length - 1 ? { provider: t.slice(0, slash), id: t.slice(slash + 1) } : null;
}

// ─── catalog ──────────────────────────────────────────────────────────────

export const FAL_MODELS: CachedModel[] = [
  { provider: "fal", id: "fal-ai/flux-2/klein/4b", name: "FLUX.2 [klein] 4B", input: ["text"], output: ["image"], kind: "images" },
  { provider: "fal", id: "fal-ai/flux-2/klein/4b/edit", name: "FLUX.2 [klein] 4B edit", input: ["text", "image"], output: ["image"], kind: "images" },
  { provider: "fal", id: "fal-ai/flux-2", name: "FLUX.2 [dev]", input: ["text"], output: ["image"], kind: "images" },
  { provider: "fal", id: "fal-ai/flux-2/edit", name: "FLUX.2 [dev] edit", input: ["text", "image"], output: ["image"], kind: "images" },
  { provider: "fal", id: "fal-ai/nano-banana-pro", name: "Nano Banana Pro", input: ["text"], output: ["image"], kind: "images" },
  { provider: "fal", id: "fal-ai/nano-banana-pro/edit", name: "Nano Banana Pro edit", input: ["text", "image"], output: ["image"], kind: "images" },
];

const IMAGE_CACHE_TTL_MS = 24 * 3600_000;

function imageCachePath(): string {
  return path.join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".unipi", "config", "image-models-cache.json");
}

export function readImageModelCache(): { updatedAt: number; models: CachedModel[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(imageCachePath(), "utf-8")) as { updatedAt?: number; models?: CachedModel[] };
    return { updatedAt: raw.updatedAt ?? 0, models: Array.isArray(raw.models) ? raw.models : [] };
  } catch {
    return { updatedAt: 0, models: [] };
  }
}

const modalities = (list: unknown): Modality[] =>
  Array.isArray(list) ? (list.filter((m) => m === "text" || m === "image") as Modality[]) : [];

/** OpenRouter /models (image output) → cache entries. */
export function parseOpenRouterImageModels(json: unknown): CachedModel[] {
  const data = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: CachedModel[] = [];
  for (const raw of data) {
    const m = raw as { id?: unknown; name?: unknown; architecture?: { input_modalities?: unknown; output_modalities?: unknown } };
    if (typeof m.id !== "string" || m.id.startsWith("openrouter/")) continue;
    const output = modalities(m.architecture?.output_modalities);
    if (!output.includes("image")) continue;
    const input = modalities(m.architecture?.input_modalities);
    out.push({ provider: "openrouter", id: m.id, ...(typeof m.name === "string" ? { name: m.name } : {}), input: input.length ? input : ["text"], output, kind: "images" });
  }
  return out;
}

/** Refresh the OpenRouter image list when stale; never throws. */
export async function refreshImageModelCache(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  const current = readImageModelCache();
  if (current.models.length > 0 && now - current.updatedAt < IMAGE_CACHE_TTL_MS) return false;
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/models?output_modalities=image", { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return false;
    const models = parseOpenRouterImageModels(await res.json());
    if (models.length === 0) return false;
    fs.mkdirSync(path.dirname(imageCachePath()), { recursive: true });
    fs.writeFileSync(imageCachePath(), JSON.stringify({ updatedAt: now, models }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function falKey(config: ImageConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return config.keys.fal || env.FAL_KEY || env.FAL_API_KEY || undefined;
}

/** Image entries to merge into the shared model cache (first wins on dupes). */
export function imageCatalogEntries(config: ImageConfig, env: NodeJS.ProcessEnv = process.env): CachedModel[] {
  return [...readImageModelCache().models, ...(falKey(config, env) ? FAL_MODELS : [])];
}

/** Modalities of a reference, from the shared cache (undefined = unknown). */
export function lookupModel(ref: string): CachedModel | undefined {
  return readModelCache().find((m) => `${m.provider}/${m.id}` === ref);
}

// ─── routing ──────────────────────────────────────────────────────────────

export interface Route {
  api: ImageApi;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  label: string;
  output?: string[];
}

function providerBaseUrl(registry: ModelRegistryLike | undefined, provider: string): string | undefined {
  try {
    const models = (registry?.getAvailable?.() ?? registry?.getAll() ?? []) as Array<{ provider?: string; baseUrl?: string }>;
    return models.find((m) => m.provider === provider && m.baseUrl)?.baseUrl;
  } catch {
    return undefined;
  }
}

async function registryKey(registry: ModelRegistryLike | undefined, provider: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const key = await registry?.getApiKeyForProvider?.(provider);
    if (key) return key;
  } catch {
    // fall through
  }
  return env[`${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`] || undefined;
}

/**
 * Where and how to send a generate/edit request. Throws a message that says
 * exactly what to set when a key or endpoint is missing.
 */
export async function resolveRoute(
  ref: string,
  endpoint: EndpointSettings,
  config: ImageConfig,
  registry: ModelRegistryLike | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Route> {
  const model = ref.trim();
  if (!model) throw new Error("No image model configured — pick one in /unipi:settings → Image.");
  if (endpoint.baseUrl.trim()) {
    if (!endpoint.apiKey) throw new Error(`The custom image endpoint ${endpoint.baseUrl} has no key — set it in /unipi:settings → Image.`);
    return { api: endpoint.api, baseUrl: endpoint.baseUrl.trim(), apiKey: endpoint.apiKey, modelId: model, label: `${model} @ ${endpoint.baseUrl.trim()}` };
  }
  const parts = splitRef(model);
  if (!parts) throw new Error(`"${model}" is not a provider/model-id reference.`);
  const output = lookupModel(model)?.output;
  if (parts.provider === "openrouter") {
    const apiKey = config.keys.openrouter || (await registryKey(registry, "openrouter", env));
    if (!apiKey) throw new Error("No OpenRouter key. Set Keys → OpenRouter key in /unipi:settings → Image, log in with /login, or export OPENROUTER_API_KEY.");
    return { api: "openrouter", baseUrl: "", apiKey, modelId: parts.id, label: model, ...(output ? { output } : {}) };
  }
  if (parts.provider === "fal") {
    const apiKey = falKey(config, env);
    if (!apiKey) throw new Error("No fal key. Set Keys → fal key in /unipi:settings → Image, or export FAL_KEY.");
    return { api: "fal", baseUrl: "", apiKey, modelId: parts.id, label: model };
  }
  const baseUrl = providerBaseUrl(registry, parts.provider);
  if (!baseUrl) throw new Error(`Provider "${parts.provider}" is not configured in pi, so there is no endpoint for ${model}. Pick an openrouter/ or fal/ model, or set a custom endpoint.`);
  const apiKey = await registryKey(registry, parts.provider, env);
  if (!apiKey) throw new Error(`No key for provider "${parts.provider}". Log in with /login or set a custom endpoint key.`);
  return { api: "openai-images", baseUrl, apiKey, modelId: parts.id, label: model };
}

// ─── vision (recognize) ───────────────────────────────────────────────────

export interface VisionModel {
  id: string;
  provider: string;
  name?: string;
  input?: string[];
  baseUrl?: string;
  api?: string;
}

export function isVisionModel(model: unknown): model is VisionModel {
  const m = model as Partial<VisionModel> | null;
  return !!m && typeof m.id === "string" && typeof m.provider === "string" && Array.isArray(m.input) && m.input.includes("image");
}

/** Active tools with image_recognize hidden for vision models, restored for text-only ones. */
export function applyRecognizeGating(active: string[], model: unknown, tool: string): string[] {
  const vision = isVisionModel(model);
  const present = active.includes(tool);
  if (vision !== present) return active;
  return vision ? active.filter((n) => n !== tool) : [...active, tool];
}

/** A registry vision model by reference (exact, then id, then substring). */
export function resolveVisionModel(ref: string, registry: ModelRegistryLike): VisionModel | string {
  let all: unknown[] = [];
  try {
    all = registry.getAvailable?.() ?? registry.getAll();
  } catch {
    all = [];
  }
  const vision = all.filter(isVisionModel);
  const q = ref.trim().toLowerCase();
  const full = (m: VisionModel) => `${m.provider}/${m.id}`.toLowerCase();
  const hit = vision.find((m) => full(m) === q) ?? vision.find((m) => m.id.toLowerCase() === q) ?? vision.find((m) => full(m).includes(q));
  if (hit) return hit;
  const known = all.find((m) => {
    const c = m as Partial<VisionModel>;
    return typeof c.id === "string" && typeof c.provider === "string" && (`${c.provider}/${c.id}`.toLowerCase() === q || c.id.toLowerCase() === q);
  });
  if (known) return `Model "${ref}" does not accept image input. Vision models: ${vision.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ")}`;
  return `Unknown vision model "${ref}". Vision models: ${vision.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ") || "none configured"}`;
}
