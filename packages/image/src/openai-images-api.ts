/**
 * @pi-unipi/image — Generic OpenAI-compatible images adapter
 *
 * ONE adapter for every provider, rather than per-provider code. It speaks the
 * OpenAI `POST {baseUrl}/images/generations` shape, which every gateway we have
 * tested implements (OpenAI itself, OpenRouter, and OmniRoute's fan-out to
 * openrouter/antigravity/codex/fal-ai backends).
 *
 * Why not pi-ai's built-in `api/openrouter-images`?
 * Despite the name it drives `chat.completions` with `modalities:["image"]`.
 * Gateways that do not implement that extension answer HTTP 200 with the model
 * *narrating* the image ("Here's the image with the circle changed…") while
 * silently dropping `message.images`. That is invisible data loss, so we use
 * the dedicated images endpoint instead.
 *
 * Editing rides the same endpoint: `POST /images/generations` with an `image`
 * array. `/images/edits` (multipart) is NOT used — gateways reject it for most
 * providers ("Image edit is not supported for built-in provider ...").
 */

import type { ImageGenModel } from "./models.js";

/** pi-ai's `ImagesContext` input parts. */
export interface ImagesInputPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ImagesContextLike {
  input: ImagesInputPart[];
}

export interface ImagesOptionsLike {
  apiKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string | null>;
  timeoutMs?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

/** pi-ai's `AssistantImages`. */
export interface AssistantImagesLike {
  api: string;
  provider: string;
  model: string;
  output: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

/** Images are slow — a minute is not unusual for a large model. */
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * One returned image, normalized.
 *
 * Gateways disagree on the item shape; all three observed forms are accepted:
 *   - `{ b64_json, media_type }`   — openrouter/* (note `media_type`, not `mimeType`)
 *   - `{ b64_json, revised_prompt }` — antigravity/*
 *   - `{ url: "data:image/png;base64,…" }` — codex/*
 * A plain http(s) `url` is also tolerated and reported as text, since we cannot
 * inline bytes we did not fetch.
 */
interface RawImageItem {
  b64_json?: unknown;
  url?: unknown;
  media_type?: unknown;
  mime_type?: unknown;
  mimeType?: unknown;
  revised_prompt?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Pull `{ data, mimeType }` out of one response item, whatever its shape. */
export function normalizeImageItem(
  item: RawImageItem,
): { data: string; mimeType: string } | { text: string } | null {
  const declared =
    asString(item.media_type) ?? asString(item.mime_type) ?? asString(item.mimeType);

  const b64 = asString(item.b64_json);
  if (b64) return { data: b64, mimeType: declared ?? "image/png" };

  const url = asString(item.url);
  if (!url) return null;

  // codex/* returns the bytes as a data: URL rather than b64_json.
  const dataUrl = /^data:([^;,]+)(?:;[^,]*)*,(.*)$/s.exec(url);
  if (dataUrl) {
    const [, mime, payload] = dataUrl;
    if (payload) return { data: payload, mimeType: declared ?? mime ?? "image/png" };
    return null;
  }

  // A remote URL: surface it rather than silently dropping the result.
  return { text: `Image available at: ${url}` };
}

/** Strip a trailing slash so `${base}/images/generations` is well-formed. */
function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

/**
 * Model ids are sent to the gateway verbatim.
 *
 * Do NOT try to "repair" a doubled-looking segment. OmniRoute genuinely serves
 * `fal-ai/fal-ai/nano-banana-pro` (provider `fal-ai` + model `fal-ai/nano-...`),
 * and rewriting it to `fal-ai/nano-banana-pro` yields a 404. Confusingly the
 * gateway *also* advertises a `fal/...` alias in `/v1/models` that the images
 * endpoint then rejects with "Invalid image model" — an upstream inconsistency
 * we surface rather than guess around, because a wrong guess turns a clear
 * error into a silently different model.
 */
export function normalizeModelId(id: string): string {
  return id;
}

/** Merge caller headers, dropping keys explicitly suppressed with null. */
function buildHeaders(
  apiKey: string,
  extra?: Record<string, string | null>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

/** Best-effort extraction of a provider error message. */
function describeError(status: number, statusText: string, body: string): string {
  let detail = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Non-JSON body — the truncated text is the best we have.
  }
  return `${status} ${statusText}${detail ? `: ${detail}` : ""}`;
}

/** Add guidance for the gateway's confusing model-id errors. */
function annotateModelError(message: string, model: ImageGenModel): string {
  if (/invalid image model|not found|unknown model/i.test(message)) {
    return (
      `${message}\n` +
      `→ Model id sent: "${model.id}" (provider "${model.provider}").\n` +
      "→ Some gateways list aliases they cannot serve. Try the id exactly as it " +
      "appears in the provider's own catalog, or pick another with /unipi:image-settings."
    );
  }
  return message;
}

/**
 * Generate (or edit) images against an OpenAI-compatible endpoint.
 *
 * Satisfies pi-ai's `ProviderImages` interface, so the result is returned —
 * never thrown — with `stopReason: "error"` on failure.
 */
export async function generateImages(
  model: ImageGenModel,
  context: ImagesContextLike,
  options?: ImagesOptionsLike,
): Promise<AssistantImagesLike> {
  const result: AssistantImagesLike = {
    api: model.api || "openai-images",
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };

  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    if (!model.baseUrl) {
      throw new Error(`No baseUrl for image model ${model.provider}/${model.id}`);
    }

    // Text parts form the prompt; image parts switch the request into edit mode.
    const prompt = context.input
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text as string)
      .join("\n")
      .trim();

    const images = context.input
      .filter((part) => part.type === "image" && part.data)
      .map((part) => `data:${part.mimeType || "image/png"};base64,${part.data}`);

    if (!prompt) throw new Error("A non-empty prompt is required.");

    const body: Record<string, unknown> = {
      model: normalizeModelId(model.id),
      prompt,
    };
    // Only send `image` for edits; some backends reject an empty array.
    if (images.length > 0) body.image = images;

    const response = await fetchImpl(joinUrl(model.baseUrl, "images/generations"), {
      method: "POST",
      headers: buildHeaders(apiKey, options?.headers),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        describeError(response.status, response.statusText, await response.text()),
      );
    }

    const payload = (await response.json()) as {
      data?: RawImageItem[];
      error?: { message?: string };
    };

    if (payload.error?.message) throw new Error(payload.error.message);

    for (const item of payload.data ?? []) {
      const normalized = normalizeImageItem(item);
      if (!normalized) continue;
      if ("text" in normalized) {
        result.output.push({ type: "text", text: normalized.text });
      } else {
        result.output.push({
          type: "image",
          data: normalized.data,
          mimeType: normalized.mimeType,
        });
      }
      const revised = asString(item.revised_prompt);
      if (revised && revised !== prompt) {
        result.output.push({ type: "text", text: `Revised prompt: ${revised}` });
      }
    }

    if (result.output.every((part) => part.type !== "image")) {
      throw new Error("The provider returned no image data.");
    }

    return result;
  } catch (error) {
    const aborted = options?.signal?.aborted || controller.signal.aborted;
    result.stopReason = options?.signal?.aborted ? "aborted" : "error";
    result.errorMessage =
      aborted && !options?.signal?.aborted
        ? "Image request timed out."
        : annotateModelError(
            error instanceof Error ? error.message : String(error),
            model,
          );
    return result;
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener("abort", onAbort);
  }
}
