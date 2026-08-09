/**
 * Tests for the generic OpenAI-compatible images adapter.
 *
 * The three response shapes covered here are not hypothetical — each was
 * observed from a different backend behind one gateway.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateImages,
  normalizeImageItem,
  normalizeModelId,
} from "../src/openai-images-api.js";
import type { ImageGenModel } from "../src/models.js";

const MODEL: ImageGenModel = {
  id: "google/gemini-3-pro-image",
  provider: "omniroute",
  api: "openai-images",
  baseUrl: "https://router.example/v1",
  output: ["image"],
};

/** A fetch stub returning one canned JSON payload. */
function stubFetch(payload: unknown, init?: { status?: number; body?: string }) {
  const calls: Array<{ url: string; body: unknown; headers: unknown }> = [];
  const impl = (async (url: unknown, options: unknown) => {
    const opts = options as { body?: string; headers?: unknown };
    calls.push({
      url: String(url),
      body: opts?.body ? JSON.parse(opts.body) : undefined,
      headers: opts?.headers,
    });
    const status = init?.status ?? 200;
    const text = init?.body ?? JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("normalizeModelId", () => {
  it("passes a doubled-looking segment through untouched", () => {
    // Verified live: `fal-ai/fal-ai/nano-banana-pro` is the REAL id and returns
    // 200, while "repairing" it to `fal-ai/nano-banana-pro` gives a 404.
    assert.equal(
      normalizeModelId("fal-ai/fal-ai/nano-banana-pro"),
      "fal-ai/fal-ai/nano-banana-pro",
    );
  });

  it("leaves an ordinary provider/model id alone", () => {
    assert.equal(
      normalizeModelId("google/gemini-3-pro-image"),
      "google/gemini-3-pro-image",
    );
  });

  it("passes through a bare id", () => {
    assert.equal(normalizeModelId("dall-e-3"), "dall-e-3");
  });
});

describe("normalizeImageItem", () => {
  it("reads the openrouter shape (b64_json + media_type)", () => {
    const out = normalizeImageItem({ b64_json: "AAAA", media_type: "image/webp" });
    assert.deepEqual(out, { data: "AAAA", mimeType: "image/webp" });
  });

  it("defaults the mime type when only b64_json is present", () => {
    const out = normalizeImageItem({ b64_json: "AAAA", revised_prompt: "x" });
    assert.deepEqual(out, { data: "AAAA", mimeType: "image/png" });
  });

  it("reads the codex shape (data: URL under `url`)", () => {
    const out = normalizeImageItem({ url: "data:image/jpeg;base64,BBBB" });
    assert.deepEqual(out, { data: "BBBB", mimeType: "image/jpeg" });
  });

  it("surfaces a remote URL as text rather than dropping it", () => {
    const out = normalizeImageItem({ url: "https://cdn.example/a.png" });
    assert.deepEqual(out, { text: "Image available at: https://cdn.example/a.png" });
  });

  it("returns null for an unusable item", () => {
    assert.equal(normalizeImageItem({}), null);
  });
});

describe("generateImages", () => {
  it("posts to /images/generations and returns the image", async () => {
    const { impl, calls } = stubFetch({
      data: [{ b64_json: "IMG", media_type: "image/png" }],
    });

    const result = await generateImages(
      MODEL,
      { input: [{ type: "text", text: "a red circle" }] },
      { apiKey: "k", fetchImpl: impl },
    );

    assert.equal(result.stopReason, "stop");
    assert.equal(calls[0]?.url, "https://router.example/v1/images/generations");
    const body = calls[0]?.body as { model: string; prompt: string; image?: unknown };
    assert.equal(body.model, "google/gemini-3-pro-image");
    assert.equal(body.prompt, "a red circle");
    // No source image: `image` must be absent, not an empty array.
    assert.equal("image" in body, false);
    assert.deepEqual(result.output[0], {
      type: "image",
      data: "IMG",
      mimeType: "image/png",
    });
  });

  it("sends an `image` array when editing", async () => {
    const { impl, calls } = stubFetch({ data: [{ b64_json: "OUT" }] });

    await generateImages(
      MODEL,
      {
        input: [
          { type: "text", text: "make it blue" },
          { type: "image", data: "SRC", mimeType: "image/png" },
        ],
      },
      { apiKey: "k", fetchImpl: impl },
    );

    const body = calls[0]?.body as { image: string[] };
    assert.deepEqual(body.image, ["data:image/png;base64,SRC"]);
  });

  it("annotates a confusing model-id error with the id actually sent", async () => {
    const { impl } = stubFetch(null, {
      status: 400,
      body: JSON.stringify({
        error: { message: "Invalid image model: fal/x. Use format: provider/model" },
      }),
    });

    const result = await generateImages(
      { ...MODEL, id: "fal/x" },
      { input: [{ type: "text", text: "x" }] },
      { apiKey: "k", fetchImpl: impl },
    );

    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /Model id sent: "fal\/x"/);
    assert.match(result.errorMessage ?? "", /image-settings/);
  });

  it("reports a provider error without throwing", async () => {
    const { impl } = stubFetch(null, {
      status: 400,
      body: JSON.stringify({ error: { message: "No credentials for image provider" } }),
    });

    const result = await generateImages(
      MODEL,
      { input: [{ type: "text", text: "x" }] },
      { apiKey: "k", fetchImpl: impl },
    );

    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No credentials for image provider/);
  });

  it("errors when the response carries no image", async () => {
    const { impl } = stubFetch({ data: [] });

    const result = await generateImages(
      MODEL,
      { input: [{ type: "text", text: "x" }] },
      { apiKey: "k", fetchImpl: impl },
    );

    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /no image data/i);
  });

  it("requires an API key", async () => {
    const { impl } = stubFetch({ data: [] });
    const result = await generateImages(
      MODEL,
      { input: [{ type: "text", text: "x" }] },
      { fetchImpl: impl },
    );
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No API key/);
  });

  it("requires a baseUrl", async () => {
    const { impl } = stubFetch({ data: [] });
    const result = await generateImages(
      { ...MODEL, baseUrl: undefined },
      { input: [{ type: "text", text: "x" }] },
      { apiKey: "k", fetchImpl: impl },
    );
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No baseUrl/);
  });
});
