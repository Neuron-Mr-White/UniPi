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
 * ⚠️ Do NOT reach for `getImageModels`/`getImageProviders`/`generateImages`:
 *
 *   - They are NOT re-exported from the pi-ai package root. Importing
 *     `@earendil-works/pi-ai` and calling `getImageModels("openrouter")`
 *     returns an EMPTY ARRAY rather than throwing, so the mistake looks like
 *     "no models are installed" and costs a long debugging session.
 *   - The file that defines them, `dist/image-models.js`, is not a permitted
 *     subpath in pi-ai's `exports` map, so importing it directly throws
 *     ERR_PACKAGE_PATH_NOT_EXPORTED.
 *
 * The supported entry point is `@earendil-works/pi-ai/providers/all` →
 * `builtinImagesModels()`, which returns the catalog AND resolves auth.
 * A failure is not fatal: it degrades to null and callers report that no
 * models are available.
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

/**
 * Providers pi-ai's images collection can actually generate with.
 *
 * This is NOT the same set as pi's chat model registry: a chat provider
 * registered by another extension may list image models that image generation
 * cannot drive. Empty means "unknown", which callers treat as permissive.
 */
export async function getGeneratingProviders(): Promise<string[]> {
  const images = await getImagesModels();
  if (!images) return [];
  try {
    return [...new Set(images.getModels().map((m) => m.provider))];
  } catch {
    return [];
  }
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

/**
 * Heuristic: does a chat-registry model look like an image generator?
 *
 * Third-party providers registered by other extensions (pi-omniroute-bridge,
 * for example) surface text-to-image endpoints as ordinary chat models. They
 * declare no `output` modality at all, so a strict `output.includes("image")`
 * check finds nothing and the user sees only pi-ai's built-in OpenRouter
 * catalog. We therefore accept an explicit image output when present, and
 * otherwise fall back to well-known generator naming.
 */
const GENERATOR_NAME_HINTS = [
  "text-to-image",
  "flux",
  "dall-e",
  "dalle",
  "imagen",
  "recraft",
  "seedream",
  "riverflow",
  "grok-imagine",
  "stable-diffusion",
  "sdxl",
  "midjourney",
  "ideogram",
  "nano-banana",
];

export function looksLikeImageGenerator(model: {
  id: string;
  name?: string;
  output?: string[];
}): boolean {
  // An explicit declaration always wins.
  if (Array.isArray(model.output)) {
    if (model.output.includes("image")) return true;
    // Declared, but text-only — trust it and do not guess from the name.
    if (model.output.length > 0) return false;
  }

  const haystack = `${model.id} ${model.name ?? ""}`.toLowerCase();
  // Match "image" as a delimited segment ("gpt-5-image", "gemini-3-pro-image"),
  // not the bare word anywhere — which would wrongly catch vision models such
  // as "claude-image-understanding". \b handles the whitespace between id and
  // name; a character class alone missed ids ending the id portion.
  if (/(^|[/\-_\s])image\b/.test(haystack) && !haystack.includes("understand")) {
    return true;
  }
  return GENERATOR_NAME_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * Image-generation models discovered from the chat registry — i.e. providers
 * registered by other extensions, which pi-ai's built-in catalog knows nothing
 * about.
 */
export function listRegistryImageGenModels(
  registry: ChatModelRegistry,
): ImageGenModel[] {
  let models: unknown[];
  try {
    models = registry.getAvailable?.() ?? registry.getAll();
  } catch {
    return [];
  }

  const out: ImageGenModel[] = [];
  for (const model of models) {
    if (model === null || typeof model !== "object") continue;
    const candidate = model as Partial<ImageGenModel>;
    if (typeof candidate.id !== "string" || typeof candidate.provider !== "string") {
      continue;
    }
    if (!looksLikeImageGenerator(candidate as ImageGenModel)) continue;
    out.push({
      id: candidate.id,
      provider: candidate.provider,
      name: candidate.name,
      api: candidate.api ?? "",
      // Carry the endpoint through. The generic images adapter POSTs to
      // `{baseUrl}/images/generations`, and this is the only place the
      // registry's baseUrl is available — dropping it here surfaces later as
      // "No baseUrl for image model ..." once generation is attempted.
      ...(candidate.baseUrl ? { baseUrl: candidate.baseUrl } : {}),
      ...(candidate.output ? { output: candidate.output } : {}),
    });
  }
  return out;
}

/**
 * Find a provider's API endpoint in pi's registry.
 *
 * Needed because a model can reach generation without one: a user-typed
 * "provider/model-id" is accepted at face value by `asExplicitModelRef`, and
 * carries no baseUrl of its own.
 */
export function findProviderBaseUrl(
  registry: ChatModelRegistry | undefined,
  provider: string,
): string | undefined {
  if (!registry) return undefined;
  try {
    const models = (registry.getAvailable?.() ?? registry.getAll()) as Array<{
      provider?: string;
      baseUrl?: string;
    }>;
    return models.find((m) => m?.provider === provider && m.baseUrl)?.baseUrl;
  } catch {
    return undefined;
  }
}

/**
 * Every selectable generation model: pi-ai's built-in catalog plus anything
 * contributed by registered providers, de-duplicated by "provider/id".
 */
export async function listAllImageGenModels(
  registry?: ChatModelRegistry | null,
): Promise<ImageGenModel[]> {
  const builtin = await listImageGenModels();
  const fromRegistry = registry ? listRegistryImageGenModels(registry) : [];

  const seen = new Set(builtin.map((m) => formatModelRef(m).toLowerCase()));
  const merged = [...builtin];
  for (const model of fromRegistry) {
    const key = formatModelRef(model).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
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
  const raw = input.trim();
  const query = raw.toLowerCase();
  if (!query) return "No image model specified.";
  if (models.length === 0) {
    // A fully-qualified reference still works: detection is heuristic, so the
    // user must be able to name a model we failed to discover.
    const explicit = asExplicitModelRef(raw);
    if (explicit) return explicit;
    return (
      "No image generation models are available.\n" +
      "→ Image generation requires an OpenRouter account: https://openrouter.ai/keys\n" +
      "→ Or set an exact model with /unipi:image-settings (press c to enter one manually)."
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

  // Nothing matched, but an explicit "provider/model-id" is taken at face
  // value — the catalog is not authoritative for third-party providers.
  const explicit = asExplicitModelRef(raw);
  if (explicit) return explicit;

  const sample = models.slice(0, 10).map((m) => `  ${formatModelRef(m)}`).join("\n");
  return (
    `Unknown image model "${input}".\n` +
    `Available models (${models.length} total):\n${sample}` +
    (models.length > 10 ? "\n  …run /unipi:image-settings to browse all" : "")
  );
}

/**
 * Treat a well-formed "provider/model-id" as a usable model even when it is
 * absent from the catalog.
 *
 * Generator detection is heuristic and third-party providers publish no image
 * metadata, so refusing an unknown-but-well-formed reference would make some
 * models permanently unreachable. Requiring the provider segment keeps this
 * from swallowing plain typos, which still get the "Unknown image model" list.
 */
function asExplicitModelRef(raw: string): ImageGenModel | null {
  const parts = splitModelRef(raw);
  if (!parts) return null;
  if (/\s/.test(raw)) return null;
  return { id: parts.id, provider: parts.provider, api: "" };
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

export function isVisionModel(model: unknown): model is VisionModel {
  if (model === null || typeof model !== "object") return false;
  const candidate = model as Partial<VisionModel>;
  if (typeof candidate.id !== "string" || typeof candidate.provider !== "string") {
    return false;
  }
  return Array.isArray(candidate.input) && candidate.input.includes("image");
}

/**
 * Active tool names after hiding `recognizeTool` for a vision-capable model.
 *
 * A model that accepts image input can read images natively (pi's own read
 * tool hands it the pixels), so a separate image_recognize round-trip through
 * another model only duplicates the ability and burns system-prompt context.
 * Text-only models get the tool back. Models that do not declare their input
 * modalities are treated as non-vision, matching `isVisionModel`.
 */
export function applyRecognizeGating(
  active: string[],
  model: unknown,
  recognizeTool: string,
): string[] {
  const vision = isVisionModel(model);
  const present = active.includes(recognizeTool);
  // Already correct: hidden for a vision model, or provided for a text-only one.
  if (vision !== present) return active;
  return vision
    ? active.filter((name) => name !== recognizeTool)
    : [...active, recognizeTool];
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
  const raw = input.trim();

  if (vision.length === 0) {
    // Accept an explicit reference so a provider we cannot introspect is still
    // usable (mirrors resolveImageGenModel).
    const explicit = asExplicitVisionRef(raw);
    if (explicit) return explicit;
    return (
      "No vision-capable models are configured.\n" +
      "→ image_recognize needs a model that accepts image input " +
      "(e.g. anthropic/claude-sonnet, openai/gpt-5, google/gemini-3-pro).\n" +
      "→ Configure one with /model or /unipi:image-settings."
    );
  }

  const query = raw.toLowerCase();
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

  // Unknown to the registry, but well-formed — accept it. Checked after
  // `knownButBlind` so a registered text-only model still gets the precise
  // "does not accept image input" error rather than being waved through.
  const explicit = asExplicitVisionRef(raw);
  if (explicit) return explicit;

  return (
    `Unknown model "${input}".\n` +
    `Vision-capable models: ${vision.map(formatModelRef).join(", ")}`
  );
}

/** Accept a well-formed "provider/model-id" the registry does not know. */
function asExplicitVisionRef(raw: string): VisionModel | null {
  const parts = splitModelRef(raw);
  if (!parts) return null;
  if (/\s/.test(raw)) return null;
  return { id: parts.id, provider: parts.provider, input: ["text", "image"] };
}
