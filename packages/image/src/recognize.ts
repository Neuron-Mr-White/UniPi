/**
 * @pi-unipi/image — Image recognition
 *
 * Sends an image plus a question to a vision-capable chat model. Providers
 * differ in how image parts are encoded, so the request is built per API
 * family (mirroring `packages/notify/summarize.ts`).
 */

import type { LoadedImage } from "./image-source.js";

/** How long to wait for a vision response. Images are slow. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Cap the reply so a verbose model cannot flood the context. */
const DEFAULT_MAX_TOKENS = 2048;

export interface RecognizeOptions {
  image: LoadedImage;
  /** The question to ask about the image. */
  prompt: string;
  /** System prompt steering the analysis. */
  systemPrompt: string;
  apiKey: string;
  baseUrl: string;
  /** pi-ai `Model.api`, e.g. "anthropic-messages". */
  api: string;
  modelId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTokens?: number;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

export interface RecognizeResult {
  text: string;
  model: string;
}

/** Combine an external abort signal with an internal timeout. */
function createSignal(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onAbort = () => controller.abort();
  external?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/** Extract the useful part of a provider error body. */
async function describeHttpError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string };
      detail =
        typeof parsed.error === "string"
          ? parsed.error
          : parsed.error?.message ?? body.slice(0, 300);
    } catch {
      detail = body.slice(0, 300);
    }
  } catch {
    // Body unavailable — status alone will have to do.
  }

  const base = `Vision request failed: ${response.status} ${response.statusText}`;
  return detail ? `${base}\n${detail}` : base;
}

/** Anthropic Messages API — image parts use a nested `source` object. */
async function callAnthropic(options: RecognizeOptions): Promise<string> {
  const {
    image, prompt, systemPrompt, apiKey, baseUrl, modelId,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = DEFAULT_MAX_TOKENS,
    signal: external, fetchImpl = fetch,
  } = options;

  const { signal, cleanup } = createSignal(timeoutMs, external);

  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        stream: false,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mimeType,
                  data: image.data,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal,
    });

    if (!response.ok) throw new Error(await describeHttpError(response));

    const data = await readJsonOrStream(response);

    // A streamed response arrives as deltas rather than a `content` array.
    const streamed = collectStreamedText(data);
    if (streamed !== null) return streamed;

    const typed = data as { content?: Array<{ type?: string; text?: string }> };
    return (typed.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
  } finally {
    cleanup();
  }
}

/**
 * Read a response body as JSON, tolerating a Server-Sent Events stream.
 *
 * Some OpenAI-compatible gateways (omniroute, for one) reply with
 * `text/event-stream` even when streaming was never requested. Calling
 * `response.json()` on that throws `Unexpected token 'd', "data: {"id"...`,
 * which tells the user nothing. Parse the SSE frames instead and hand back a
 * synthetic payload carrying the concatenated deltas.
 */
async function readJsonOrStream(response: Response): Promise<unknown> {
  const body = await response.text();
  const trimmed = body.trimStart();

  if (!trimmed.startsWith("data:")) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(
        `The model returned a response that could not be parsed:\n${body.slice(0, 200)}`,
      );
    }
  }

  const parts: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue; // Ignore a partial or malformed frame rather than failing.
    }
    parts.push(...extractDeltaText(frame));
  }

  return { __streamedText: parts.join("") };
}

/** Pull text out of one SSE frame, in both OpenAI and Anthropic shapes. */
function extractDeltaText(frame: unknown): string[] {
  if (frame === null || typeof frame !== "object") return [];
  const out: string[] = [];

  // OpenAI: choices[].delta.content (or a non-streamed message.content)
  const choices = (frame as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (choice === null || typeof choice !== "object") continue;
      const delta = (choice as { delta?: { content?: unknown } }).delta;
      if (typeof delta?.content === "string") out.push(delta.content);
      const message = (choice as { message?: { content?: unknown } }).message;
      if (typeof message?.content === "string") out.push(message.content);
    }
  }

  // Anthropic: content_block_delta → delta.text
  const delta = (frame as { delta?: { text?: unknown } }).delta;
  if (typeof delta?.text === "string") out.push(delta.text);

  return out;
}

/** Text collected from a streamed body, or null when it was ordinary JSON. */
function collectStreamedText(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const streamed = (data as { __streamedText?: unknown }).__streamedText;
  if (typeof streamed !== "string") return null;
  return streamed.trim();
}

/** OpenAI-compatible chat completions — image parts use a data: URL. */
async function callOpenAICompatible(options: RecognizeOptions): Promise<string> {
  const {
    image, prompt, systemPrompt, apiKey, baseUrl, modelId,
    timeoutMs = DEFAULT_TIMEOUT_MS, maxTokens = DEFAULT_MAX_TOKENS,
    signal: external, fetchImpl = fetch,
  } = options;

  const { signal, cleanup } = createSignal(timeoutMs, external);

  try {
    const response = await fetchImpl(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: maxTokens,
          // Ask for a single payload. Gateways may stream regardless, which
          // readJsonOrStream handles.
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${image.mimeType};base64,${image.data}`,
                  },
                },
              ],
            },
          ],
        }),
        signal,
      },
    );

    if (!response.ok) throw new Error(await describeHttpError(response));

    const data = await readJsonOrStream(response);

    const streamed = collectStreamedText(data);
    if (streamed !== null) return streamed;

    const typed = data as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const content = typed.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content.map((part) => part?.text ?? "").join("").trim();
    }
    return "";
  } finally {
    cleanup();
  }
}

/**
 * Analyze an image with a vision model.
 * @throws {Error} with an actionable message on failure.
 */
export async function recognizeImage(
  options: RecognizeOptions,
): Promise<RecognizeResult> {
  if (!options.apiKey) {
    throw new Error(
      "No API key available for the selected vision model.\n" +
        "→ Sign in with /login, or set the provider's API key environment variable.",
    );
  }

  const text =
    options.api === "anthropic-messages"
      ? await callAnthropic(options)
      : await callOpenAICompatible(options);

  if (!text) {
    throw new Error("The model returned an empty response for this image.");
  }

  return { text, model: options.modelId };
}
