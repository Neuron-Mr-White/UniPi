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

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };

    return (data.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n")
      .trim();
  } finally {
    cleanup();
  }
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

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const content = data.choices?.[0]?.message?.content;
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
