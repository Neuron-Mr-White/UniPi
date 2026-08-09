/**
 * @pi-unipi/image — Image generation
 *
 * Wraps pi-ai's image API. `generateImages` never rejects — failures come back
 * as `stopReason: "error"` — so every call site must inspect the result rather
 * than relying on try/catch.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getImagesModels, type ImageGenModel, type ImagesModelsLike } from "./models.js";

export interface GeneratedImage {
  /** Base64 image data. */
  data: string;
  mimeType: string;
  /** Absolute path, when saved to disk. */
  path?: string;
}

export interface GenerateResult {
  images: GeneratedImage[];
  /** Any accompanying commentary from the model. */
  text: string;
  model: string;
  provider: string;
}

/** Structural view of pi-ai's AssistantImages. */
interface AssistantImagesLike {
  output?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
}

/** Injectable generation function, for tests. */
export type GenerateImagesFn = (
  model: unknown,
  context: { input: Array<{ type: string; text?: string }> },
  options: { apiKey?: string; signal?: AbortSignal },
) => Promise<AssistantImagesLike>;

/** Extension for a media type, for naming saved files. */
function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    default:
      return ".img";
  }
}

/** Filesystem-safe slug from a prompt, for a recognizable filename. */
export function slugify(prompt: string, maxLength = 40): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "image";
}

/** Build a collision-free filename. */
export function buildFileName(
  prompt: string,
  mimeType: string,
  index: number,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${stamp}-${slugify(prompt)}${suffix}${extensionFor(mimeType)}`;
}

/**
 * Write an image to disk.
 * @returns the absolute path, or undefined if the write failed (never throws —
 * a failed save must not discard a successfully generated image).
 */
export function saveImage(
  outputDir: string,
  fileName: string,
  base64: string,
): string | undefined {
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const target = path.join(outputDir, fileName);
    fs.writeFileSync(target, Buffer.from(base64, "base64"));
    return target;
  } catch {
    return undefined;
  }
}

/** Providers pi-ai's images collection can actually generate with. */
function supportedProviders(imagesApi: ImagesModelsLike): string[] {
  try {
    return [...new Set(imagesApi.getModels().map((m) => m.provider))];
  } catch {
    return [];
  }
}

/**
 * Whether generation can route to a provider. Unknown/empty catalogs are
 * treated as capable so a stubbed or future pi-ai is never blocked by this
 * check — the real call still reports its own error.
 */
function providerCanGenerate(imagesApi: ImagesModelsLike, provider: string): boolean {
  const providers = supportedProviders(imagesApi);
  if (providers.length === 0) return true;
  return providers.includes(provider);
}

export interface GenerateOptions {
  prompt: string;
  model: ImageGenModel;
  /** Fallback key, used only when pi-ai's own auth resolution comes up empty. */
  apiKey?: string;
  signal?: AbortSignal;
  /** Absolute directory for saved images; omit to skip saving. */
  outputDir?: string;
  /** Source image; when set the request is an edit rather than a generation. */
  inputImage?: { data: string; mimeType: string };
  now?: Date;
  /** Injected images collection, for tests. */
  images?: ImagesModelsLike;
}

/**
 * Generate images and optionally save them.
 * @throws {Error} with an actionable message when generation fails.
 */
export async function generateImage(options: GenerateOptions): Promise<GenerateResult> {
  const { prompt, model, signal, outputDir, now, inputImage } = options;

  if (!prompt.trim()) {
    throw new Error("A non-empty prompt is required.");
  }

  const imagesApi = options.images ?? (await getImagesModels());
  if (!imagesApi) {
    throw new Error(
      "Image generation is unavailable — this version of pi-ai does not expose an image API.",
    );
  }

  // pi-ai's images collection has its own provider set, separate from pi's
  // chat registry. `registerRegistryImageProviders()` bridges pi's providers
  // in, but a model may still name a provider with no image route at all —
  // pi-ai would answer with a bare "Unknown provider: x", so say something
  // useful instead.
  if (!providerCanGenerate(imagesApi, model.provider)) {
    const supported = supportedProviders(imagesApi);
    throw new Error(
      `Provider "${model.provider}" has no image-generation route.\n` +
        `→ Available: ${supported.join(", ") || "openrouter"}.\n` +
        "→ Providers are bridged from pi automatically; one without a baseUrl " +
        "or an API key cannot be used.\n" +
        "→ Pick another with /unipi:image-settings.",
    );
  }

  // Prefer pi-ai's own credential store, then the caller-supplied fallback so
  // a bare OPENROUTER_API_KEY still works.
  let apiKey: string | undefined;
  try {
    // pi-ai resolves to an `AuthResult`, i.e. `{ auth: { apiKey } }`. Older
    // shapes put the key at the top level, so accept both — reading only one
    // fails silently and looks like a missing credential.
    const resolvedAuth = (await imagesApi.getAuth(model)) as
      | { apiKey?: string; auth?: { apiKey?: string } }
      | undefined;
    apiKey = resolvedAuth?.auth?.apiKey ?? resolvedAuth?.apiKey;
  } catch {
    // Reported as a missing key below.
  }
  apiKey ||= options.apiKey;

  if (!apiKey) {
    throw new Error(
      `No API key for provider "${model.provider}".\n` +
        "→ Sign in with /login, or set the provider's API key environment variable.\n" +
        `→ Expected environment variable: ` +
        `${model.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
    );
  }

  const input: Array<{ type: string; text?: string; data?: string; mimeType?: string }> =
    [{ type: "text", text: prompt }];
  if (inputImage) {
    input.push({
      type: "image",
      data: inputImage.data,
      mimeType: inputImage.mimeType,
    });
  }

  const result = (await imagesApi.generateImages(
    model,
    { input } as { input: Array<{ type: string; text?: string }> },
    { apiKey, ...(signal ? { signal } : {}) },
  )) as AssistantImagesLike;

  // pi-ai reports failures in-band rather than rejecting.
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage || "Image generation failed.");
  }
  if (result.stopReason === "aborted") {
    throw new Error("Image generation was cancelled.");
  }

  const images: GeneratedImage[] = [];
  const textParts: string[] = [];

  for (const part of result.output ?? []) {
    if (part?.type === "image" && typeof part.data === "string" && part.data.length > 0) {
      images.push({ data: part.data, mimeType: part.mimeType || "image/png" });
    } else if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      textParts.push(part.text.trim());
    }
  }

  if (images.length === 0) {
    throw new Error(
      textParts.length > 0
        ? `The model returned no image. It said: ${textParts.join(" ")}`
        : "The model returned no image.",
    );
  }

  if (outputDir) {
    images.forEach((image, index) => {
      const fileName = buildFileName(prompt, image.mimeType, index, now);
      image.path = saveImage(outputDir, fileName, image.data);
    });
  }

  return {
    images,
    text: textParts.join("\n"),
    model: model.id,
    provider: model.provider,
  };
}
