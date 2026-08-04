/**
 * @pi-unipi/image — Model discovery and resolution
 *
 * Two different model families are involved:
 *
 * - **Image generation** uses pi-ai's `ImagesModel` catalog, which
 *   pi-coding-agent does not expose on `ExtensionContext` — it is reached
 *   through the pi-ai subpath exports.
 * - **Image recognition** uses ordinary chat models filtered to those whose
 *   `input` modality includes `"image"` (`ctx.modelRegistry`).
 */

/** A generation model, kept structural to avoid deep pi-ai type coupling. */
export interface ImageGenModel {
  id: string;
  name?: string;
  provider: string;
  api: string;
  baseUrl?: string;
  input?: string[];
  output?: string[];
  [key: string]: unknown;
}

/** A vision-capable chat model. */
export interface VisionModel {
  id: string;
  name?: string;
  provider: string;
  input?: string[];
}

/** Minimal chat-model registry surface (pi's ModelRegistry). */
export interface ChatModelRegistry {
  find(provider: string, modelId: string): unknown;
  getAll(): unknown[];
  getAvailable?(): unknown[];
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
}

/** Split "provider/model-id" — the model id may itself contain slashes. */
export function splitModelRef(ref: string): { provider: string; id: string } | null {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/** Format a model as "provider/model-id". */
export function formatModelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * pi-ai's runtime image-model collection: model catalog, auth resolution and
 * generation in one object. Only the parts used here are typed.
 */
export interface ImagesModelsLike {
  getModels(provider?: string): readonly ImageGenModel[];
  getModel(provider: string, id: string): ImageGenModel | undefined;
  getAuth(model: ImageGenModel): Promise<{ apiKey?: string } | undefined>;
  generateImages(
    model: ImageGenModel,
    context: { input: Array<{ type: string; text?: string }> },
    options?: { apiKey?: string; signal?: AbortSignal },
  ): Promise<unknown>;
}

let cachedImagesModels: ImagesModelsLike | null = null;
let imagesModelsAttempted = false;

/**
 * Load pi-ai's built-in images collection.
 *
 * `getImageModels`/`generateImages` are not re-exported from the pi-ai package
 * root, but `providers/all` exports `builtinImagesModels()`, which is the
 * supported entry point and also resolves auth. A failure is not fatal: it
 * degrades to null and callers report that no models are available.
 */
export async function getImagesModels(): Promise<ImagesModelsLike | null> {
  if (cachedImagesModels || imagesModelsAttempted) return cachedImagesModels;
  imagesModelsAttempted = true;

  try {
    const mod = (await import("@earendil-works/pi-ai/providers/all")) as unknown as {
      builtinImagesModels?: () => ImagesModelsLike;
    };
    if (typeof mod.builtinImagesModels === "function") {
      cachedImagesModels = mod.builtinImagesModels();
    }
  } catch {
    cachedImagesModels = null;
  }

  return cachedImagesModels;
}

/** List available image-generation models. Empty when unavailable. */
export async function listImageGenModels(): Promise<ImageGenModel[]> {
  const images = await getImagesModels();
  if (!images) return [];
  try {
    return [...images.getModels()];
  } catch {
    return [];
  }
}

/** Inject a stub images collection. Test-only. */
export function __setImagesModelsForTests(models: ImagesModelsLike | null): void {
  cachedImagesModels = models;
  imagesModelsAttempted = models !== null;
}

/** Reset the model cache. Test-only. */
export function __resetModelCacheForTests(): void {
  cachedImagesModels = null;
  imagesModelsAttempted = false;
}

/**
 * Resolve a generation-model reference against the catalog.
 *
 * Exact "provider/id" first, then a scored fuzzy match so "flux" or
 * "gemini-3-pro" work. Returns an error string (not a throw) so the tool can
 * surface it as a normal tool error listing the alternatives.
 */
export function resolveImageGenModel(
  input: string,
  models: ImageGenModel[],
): ImageGenModel | string {
  const query = input.trim().toLowerCase();
  if (!query) return "No image model specified.";
  if (models.length === 0) {
    return (
      "No image generation models are available.\n" +
      "→ Image generation requires an OpenRouter account: https://openrouter.ai/keys"
    );
  }

  // 1. Exact "provider/id"
  const exact = models.find((m) => formatModelRef(m).toLowerCase() === query);
  if (exact) return exact;

  // 2. Exact id, ignoring the provider
  const byId = models.find((m) => m.id.toLowerCase() === query);
  if (byId) return byId;

  // 3. Fuzzy
  let best: ImageGenModel | undefined;
  let bestScore = 0;

  for (const model of models) {
    const id = model.id.toLowerCase();
    const full = formatModelRef(model).toLowerCase();
    const name = (model.name ?? model.id).toLowerCase();

    let score = 0;
    if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30;
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    }

    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  }

  if (best && bestScore > 0) return best;

  const sample = models.slice(0, 10).map((m) => `  ${formatModelRef(m)}`).join("\n");
  return (
    `Unknown image model "${input}".\n` +
    `Available models (${models.length} total):\n${sample}` +
    (models.length > 10 ? "\n  …run /unipi:image-settings to browse all" : "")
  );
}

/**
 * List vision-capable chat models — those accepting image input.
 *
 * `Model.input` is `("text" | "image")[]` in pi-ai. Models that do not declare
 * the field are excluded rather than assumed capable, so a bad guess never
 * produces a confusing API error.
 */
export function listVisionModels(registry: ChatModelRegistry): VisionModel[] {
  let models: unknown[];
  try {
    models = registry.getAvailable?.() ?? registry.getAll();
  } catch {
    return [];
  }

  return models.filter(isVisionModel);
}

function isVisionModel(model: unknown): model is VisionModel {
  if (model === null || typeof model !== "object") return false;
  const candidate = model as Partial<VisionModel>;
  if (typeof candidate.id !== "string" || typeof candidate.provider !== "string") {
    return false;
  }
  return Array.isArray(candidate.input) && candidate.input.includes("image");
}

/**
 * Resolve a vision-model reference, restricted to image-capable models.
 *
 * Rejecting a text-only model here gives a much clearer message than letting
 * the provider fail on an unexpected image part.
 */
export function resolveVisionModel(
  input: string,
  registry: ChatModelRegistry,
): VisionModel | string {
  const vision = listVisionModels(registry);

  if (vision.length === 0) {
    return (
      "No vision-capable models are configured.\n" +
      "→ image_recognize needs a model that accepts image input " +
      "(e.g. anthropic/claude-sonnet, openai/gpt-5, google/gemini-3-pro).\n" +
      "→ Configure one with /model or /unipi:image-settings."
    );
  }

  const query = input.trim().toLowerCase();
  if (!query) return "No model specified.";

  const exact = vision.find((m) => formatModelRef(m).toLowerCase() === query);
  if (exact) return exact;

  const byId = vision.find((m) => m.id.toLowerCase() === query);
  if (byId) return byId;

  let best: VisionModel | undefined;
  let bestScore = 0;

  for (const model of vision) {
    const id = model.id.toLowerCase();
    const full = formatModelRef(model).toLowerCase();
    const name = (model.name ?? model.id).toLowerCase();

    let score = 0;
    if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30;
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    }

    if (score > bestScore) {
      bestScore = score;
      best = model;
    }
  }

  if (best && bestScore > 0) return best;

  // A known model that simply cannot see gets a targeted message.
  let all: unknown[] = [];
  try {
    all = registry.getAvailable?.() ?? registry.getAll();
  } catch {
    all = [];
  }
  const knownButBlind = all.some((m) => {
    const candidate = m as Partial<VisionModel>;
    if (typeof candidate.id !== "string" || typeof candidate.provider !== "string") {
      return false;
    }
    return (
      formatModelRef(candidate as VisionModel).toLowerCase() === query ||
      candidate.id.toLowerCase() === query
    );
  });

  if (knownButBlind) {
    return `Model "${input}" does not accept image input. Vision-capable models: ${vision
      .slice(0, 5)
      .map(formatModelRef)
      .join(", ")}`;
  }

  return (
    `Unknown model "${input}".\n` +
    `Vision-capable models: ${vision.map(formatModelRef).join(", ")}`
  );
}
