/**
 * @pi-unipi/utility — image generation transports
 *
 * Three wire formats, one result shape. Every function THROWS on failure with
 * a message worth showing the agent (pi only marks a tool result as failed
 * when execute() throws).
 *
 *   openrouter    POST {base}/chat/completions, `modalities`, images come back
 *                 as data URLs in choices[0].message.images
 *   fal           POST https://fal.run/<model>, `sync_mode` → data URIs;
 *                 edits send `image_urls`
 *   openai-images POST {base}/images/generations; edits send an `image` array
 *                 (the shape OpenAI, OmniRoute and most gateways accept)
 */

import type { ImageApi } from "./settings.js";

export interface ImagePayload {
  data: string;
  mimeType: string;
}

export interface GenerateRequest {
  api: ImageApi;
  /** Endpoint base (ignored for fal, which has one host). */
  baseUrl: string;
  apiKey: string;
  modelId: string;
  prompt: string;
  /** Source images → edit. */
  images?: ImagePayload[];
  /** Output modalities for OpenRouter (image-only models reject "text"). */
  output?: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GenerateResponse {
  images: ImagePayload[];
  text: string;
}

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const FAL_BASE = "https://fal.run";
const DEFAULT_TIMEOUT_MS = 240_000;

const dataUrl = (img: ImagePayload) => `data:${img.mimeType};base64,${img.data}`;

/** `data:image/png;base64,....` → payload; undefined for anything else. */
export function parseDataUrl(url: string): ImagePayload | undefined {
  const m = /^data:([^;,]+)(?:;[^,]*)*,(.*)$/s.exec(url);
  return m && m[2] ? { mimeType: m[1] || "image/png", data: m[2] } : undefined;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown; message?: string };
    if (typeof parsed.error === "string") detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
    else if (typeof parsed.message === "string") detail = parsed.message;
    else if (parsed.detail) detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail).slice(0, 400);
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`;
}

/** Fetch a remote image (fal without sync_mode, gateways returning URLs). */
async function download(url: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ImagePayload> {
  const inline = parseDataUrl(url);
  if (inline) return inline;
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`Could not download the generated image: ${res.status}`);
  const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/png";
  return { data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType };
}

function join(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

async function withTimeout<T>(req: GenerateRequest, run: (signal: AbortSignal, f: typeof fetch) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await run(controller.signal, req.fetchImpl ?? fetch);
  } catch (error) {
    if (req.signal?.aborted) throw new Error("Image request was cancelled.");
    if (controller.signal.aborted) throw new Error("Image request timed out.");
    throw error;
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

async function viaOpenRouter(req: GenerateRequest): Promise<GenerateResponse> {
  return withTimeout(req, async (signal, f) => {
    const content: unknown[] = [{ type: "text", text: req.prompt }];
    for (const img of req.images ?? []) content.push({ type: "image_url", image_url: { url: dataUrl(img) } });
    const output = req.output?.includes("image") ? req.output : ["image"];
    const res = await f(join(req.baseUrl || OPENROUTER_BASE, "chat/completions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: req.modelId, messages: [{ role: "user", content }], modalities: output }),
      signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    const json = (await res.json()) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: unknown; images?: Array<{ image_url?: { url?: string } }> } }>;
    };
    if (json.error?.message) throw new Error(json.error.message);
    const message = json.choices?.[0]?.message;
    const images: ImagePayload[] = [];
    for (const item of message?.images ?? []) {
      const url = item.image_url?.url;
      if (url) images.push(await download(url, f, signal));
    }
    const text = typeof message?.content === "string" ? message.content.trim() : "";
    return { images, text };
  });
}

async function viaFal(req: GenerateRequest): Promise<GenerateResponse> {
  return withTimeout(req, async (signal, f) => {
    const body: Record<string, unknown> = { prompt: req.prompt, sync_mode: true, num_images: 1 };
    if (req.images?.length) body.image_urls = req.images.map(dataUrl);
    const res = await f(join(req.baseUrl || FAL_BASE, req.modelId), {
      method: "POST",
      headers: { Authorization: `Key ${req.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    const json = (await res.json()) as { images?: Array<{ url?: string }>; image?: { url?: string }; description?: string };
    const images: ImagePayload[] = [];
    for (const item of json.images ?? (json.image ? [json.image] : [])) {
      if (item.url) images.push(await download(item.url, f, signal));
    }
    return { images, text: typeof json.description === "string" ? json.description : "" };
  });
}

async function viaOpenAIImages(req: GenerateRequest): Promise<GenerateResponse> {
  if (!req.baseUrl) throw new Error(`No endpoint for ${req.modelId}: set a custom endpoint in /unipi:settings → Image.`);
  return withTimeout(req, async (signal, f) => {
    const body: Record<string, unknown> = { model: req.modelId, prompt: req.prompt };
    if (req.images?.length) body.image = req.images.map(dataUrl);
    const res = await f(join(req.baseUrl, "images/generations"), {
      method: "POST",
      headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(await readError(res));
    const json = (await res.json()) as { error?: { message?: string }; data?: Array<{ b64_json?: string; url?: string; media_type?: string; mime_type?: string; revised_prompt?: string }> };
    if (json.error?.message) throw new Error(json.error.message);
    const images: ImagePayload[] = [];
    const notes: string[] = [];
    for (const item of json.data ?? []) {
      const declared = item.media_type ?? item.mime_type;
      if (item.b64_json) images.push({ data: item.b64_json, mimeType: declared ?? "image/png" });
      else if (item.url) images.push(await download(item.url, f, signal));
      if (item.revised_prompt && item.revised_prompt !== req.prompt) notes.push(`Revised prompt: ${item.revised_prompt}`);
    }
    return { images, text: notes.join("\n") };
  });
}

/** Run one generation/edit; throws unless at least one image came back. */
export async function generate(req: GenerateRequest): Promise<GenerateResponse> {
  if (!req.prompt.trim()) throw new Error("A non-empty prompt is required.");
  if (!req.apiKey) throw new Error("No API key for this image model.");
  const run = req.api === "fal" ? viaFal : req.api === "openrouter" ? viaOpenRouter : viaOpenAIImages;
  const out = await run(req);
  if (out.images.length === 0) {
    throw new Error(out.text ? `The model returned no image. It said: ${out.text.slice(0, 300)}` : "The model returned no image.");
  }
  return out;
}
