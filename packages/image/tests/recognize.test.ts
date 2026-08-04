/**
 * Image recognition tests.
 *
 * `fetch` is injected, so nothing leaves the machine. The important contract
 * is that Anthropic and OpenAI-compatible providers need different image
 * encodings — sending the wrong shape yields an opaque 400.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { recognizeImage, type RecognizeOptions } from "../src/recognize.ts";
import type { LoadedImage } from "../src/image-source.ts";

const IMAGE: LoadedImage = {
  data: "QUJD",
  mimeType: "image/png",
  source: "file",
  path: "/tmp/shot.png",
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Build an injectable fetch that records the request and returns `payload`. */
function stubFetch(payload: unknown, status = 200) {
  const calls: Captured[] = [];

  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function baseOptions(overrides: Partial<RecognizeOptions> = {}): RecognizeOptions {
  return {
    image: IMAGE,
    prompt: "What does this show?",
    systemPrompt: "Be precise.",
    apiKey: "test-key",
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    modelId: "gpt-5",
    ...overrides,
  };
}

describe("recognizeImage — OpenAI-compatible", () => {
  it("returns the model's answer", async () => {
    const { impl } = stubFetch({
      choices: [{ message: { content: "A login screen with a validation error." } }],
    });

    const result = await recognizeImage(baseOptions({ fetchImpl: impl }));
    assert.equal(result.text, "A login screen with a validation error.");
    assert.equal(result.model, "gpt-5");
  });

  it("sends the image as a data URL and uses a bearer token", async () => {
    const { impl, calls } = stubFetch({ choices: [{ message: { content: "ok" } }] });
    await recognizeImage(baseOptions({ fetchImpl: impl }));

    const [call] = calls;
    assert.equal(call.url, "https://api.example.com/v1/chat/completions");
    assert.equal(call.headers.Authorization, "Bearer test-key");

    const messages = call.body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, "Be precise.");

    const parts = messages[1].content as Array<Record<string, never>>;
    const imagePart = parts.find((p) => p.type === "image_url") as unknown as {
      image_url: { url: string };
    };
    assert.equal(imagePart.image_url.url, "data:image/png;base64,QUJD");
  });

  it("does not double a trailing slash on the base url", async () => {
    const { impl, calls } = stubFetch({ choices: [{ message: { content: "ok" } }] });
    await recognizeImage(
      baseOptions({ fetchImpl: impl, baseUrl: "https://api.example.com/v1/" }),
    );
    assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  });

  it("joins an array-shaped content response", async () => {
    const { impl } = stubFetch({
      choices: [{ message: { content: [{ text: "Part one. " }, { text: "Part two." }] } }],
    });
    const result = await recognizeImage(baseOptions({ fetchImpl: impl }));
    assert.equal(result.text, "Part one. Part two.");
  });
});

describe("recognizeImage — Anthropic", () => {
  it("sends a nested base64 source block and the x-api-key header", async () => {
    const { impl, calls } = stubFetch({
      content: [{ type: "text", text: "A screenshot." }],
    });

    const result = await recognizeImage(
      baseOptions({
        fetchImpl: impl,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        modelId: "claude-sonnet-4-6",
      }),
    );

    assert.equal(result.text, "A screenshot.");

    const [call] = calls;
    assert.equal(call.url, "https://api.anthropic.com/v1/messages");
    assert.equal(call.headers["x-api-key"], "test-key");
    assert.equal(call.headers["anthropic-version"], "2023-06-01");
    // Anthropic takes the system prompt as a top-level field.
    assert.equal(call.body.system, "Be precise.");

    const messages = call.body.messages as Array<{ content: Array<Record<string, never>> }>;
    const imagePart = messages[0].content.find((p) => p.type === "image") as unknown as {
      source: { type: string; media_type: string; data: string };
    };
    assert.deepEqual(imagePart.source, {
      type: "base64",
      media_type: "image/png",
      data: "QUJD",
    });
  });

  it("concatenates multiple text blocks", async () => {
    const { impl } = stubFetch({
      content: [
        { type: "text", text: "First." },
        { type: "thinking", thinking: "ignored" },
        { type: "text", text: "Second." },
      ],
    });

    const result = await recognizeImage(
      baseOptions({ fetchImpl: impl, api: "anthropic-messages" }),
    );
    assert.equal(result.text, "First.\nSecond.");
  });
});

describe("recognizeImage — failures", () => {
  it("requires an API key", async () => {
    await assert.rejects(
      () => recognizeImage(baseOptions({ apiKey: "" })),
      /No API key available/,
    );
  });

  it("surfaces the provider's error message", async () => {
    const { impl } = stubFetch({ error: { message: "model does not support images" } }, 400);
    await assert.rejects(
      () => recognizeImage(baseOptions({ fetchImpl: impl })),
      /model does not support images/,
    );
  });

  it("includes the status when the body is unhelpful", async () => {
    const { impl } = stubFetch("gateway timeout", 504);
    await assert.rejects(() => recognizeImage(baseOptions({ fetchImpl: impl })), /504/);
  });

  it("throws on an empty response", async () => {
    const { impl } = stubFetch({ choices: [{ message: { content: "" } }] });
    await assert.rejects(
      () => recognizeImage(baseOptions({ fetchImpl: impl })),
      /empty response/,
    );
  });

  it("propagates an external abort", async () => {
    const controller = new AbortController();
    const impl = (async (_url: string, init: RequestInit) => {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (init.signal?.aborted) throw new Error("The operation was aborted");
      return {} as Response;
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => recognizeImage(baseOptions({ fetchImpl: impl, signal: controller.signal })),
      /abort/i,
    );
  });
});

// ─── SSE / streamed responses ────────────────────────────────────────

/**
 * Some OpenAI-compatible gateways return `text/event-stream` even when
 * streaming was never requested. Calling `response.json()` on that body throws
 * `Unexpected token 'd', "data: {"id"...`, which is opaque to the user.
 * Reproduced live against a real gateway before this was fixed.
 */
function stubSseFetch(frames: string[]) {
  const body = frames.map((f) => `data: ${f}`).join("\n\n") + "\n\ndata: [DONE]\n\n";
  const impl = (async () =>
    ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new SyntaxError(`Unexpected token 'd', "${body.slice(0, 10)}..." is not valid JSON`);
      },
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
  return impl;
}

describe("recognizeImage — streamed (SSE) responses", () => {
  it("parses an OpenAI-style delta stream", async () => {
    const impl = stubSseFetch([
      JSON.stringify({ choices: [{ delta: { role: "assistant" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "A dark " } }] }),
      JSON.stringify({ choices: [{ delta: { content: "cyan stripe." } }] }),
    ]);
    const result = await recognizeImage(baseOptions({ fetchImpl: impl }));
    assert.equal(result.text, "A dark cyan stripe.");
  });

  it("parses an Anthropic-style delta stream", async () => {
    const impl = stubSseFetch([
      JSON.stringify({ type: "content_block_delta", delta: { text: "Hello " } }),
      JSON.stringify({ type: "content_block_delta", delta: { text: "world." } }),
    ]);
    const result = await recognizeImage(
      baseOptions({ fetchImpl: impl, api: "anthropic-messages" }),
    );
    assert.equal(result.text, "Hello world.");
  });

  it("ignores malformed frames instead of failing the whole request", async () => {
    const impl = stubSseFetch([
      JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
      "{not json",
      JSON.stringify({ choices: [{ delta: { content: " still ok" } }] }),
    ]);
    const result = await recognizeImage(baseOptions({ fetchImpl: impl }));
    assert.equal(result.text, "ok still ok");
  });

  it("requests a non-streamed response", async () => {
    const { impl, calls } = stubFetch({
      choices: [{ message: { content: "x" } }],
    });
    await recognizeImage(baseOptions({ fetchImpl: impl }));
    assert.equal(calls[0].body.stream, false);
  });

  it("reports unparseable non-SSE bodies readably", async () => {
    const impl = (async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          throw new SyntaxError("bad");
        },
        text: async () => "<html>gateway error</html>",
      }) as unknown as Response) as unknown as typeof fetch;

    await assert.rejects(
      () => recognizeImage(baseOptions({ fetchImpl: impl })),
      /could not be parsed/,
    );
  });
});
