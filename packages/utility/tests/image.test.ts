/**
 * @pi-unipi/utility — image transports, routing and catalog (no network)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../src/image/transports.ts";
import { parseOpenRouterImageModels, resolveRoute, applyRecognizeGating, resolveVisionModel } from "../src/image/models.ts";
import { DEFAULT_CONFIG } from "../src/image/settings.ts";
import { saveImages } from "../src/image/tools.ts";

const PNG = Buffer.from("fake-png").toString("base64");

function fakeFetch(handler: (url: string, body: Record<string, unknown>, headers: Record<string, string>) => unknown, status = 200) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body, headers });
    return new Response(JSON.stringify(handler(url, body, headers)), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("transports", () => {
  it("openrouter: chat completions with modalities, images from message.images", async () => {
    const f = fakeFetch(() => ({ choices: [{ message: { content: "", images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] }));
    const out = await generate({ api: "openrouter", baseUrl: "", apiKey: "k", modelId: "black-forest-labs/flux.2-klein-4b", prompt: "a cube", output: ["image"], fetchImpl: f.impl });
    assert.equal(f.calls[0]!.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepEqual(f.calls[0]!.body.modalities, ["image"]);
    assert.equal(f.calls[0]!.headers.Authorization, "Bearer k");
    assert.deepEqual(out.images, [{ data: PNG, mimeType: "image/png" }]);
  });

  it("openrouter edit sends the source image as image_url", async () => {
    const f = fakeFetch(() => ({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${PNG}` } }] } }] }));
    await generate({ api: "openrouter", baseUrl: "", apiKey: "k", modelId: "m", prompt: "make it blue", images: [{ data: PNG, mimeType: "image/png" }], fetchImpl: f.impl });
    const content = (f.calls[0]!.body.messages as Array<{ content: Array<{ type: string }> }>)[0]!.content;
    assert.deepEqual(content.map((c) => c.type), ["text", "image_url"]);
  });

  it("fal: fal.run/<model>, Key auth, sync_mode data URIs, image_urls for edits", async () => {
    const f = fakeFetch(() => ({ images: [{ url: `data:image/jpeg;base64,${PNG}`, content_type: "image/jpeg" }] }));
    const out = await generate({ api: "fal", baseUrl: "", apiKey: "fk", modelId: "fal-ai/flux-2/klein/4b/edit", prompt: "p", images: [{ data: PNG, mimeType: "image/png" }], fetchImpl: f.impl });
    assert.equal(f.calls[0]!.url, "https://fal.run/fal-ai/flux-2/klein/4b/edit");
    assert.equal(f.calls[0]!.headers.Authorization, "Key fk");
    assert.equal(f.calls[0]!.body.sync_mode, true);
    assert.deepEqual(f.calls[0]!.body.image_urls, [`data:image/png;base64,${PNG}`]);
    assert.equal(out.images[0]!.mimeType, "image/jpeg");
  });

  it("openai-images: b64_json items and revised prompts", async () => {
    const f = fakeFetch(() => ({ data: [{ b64_json: PNG, media_type: "image/webp", revised_prompt: "better" }] }));
    const out = await generate({ api: "openai-images", baseUrl: "https://gw/v1/", apiKey: "k", modelId: "flux", prompt: "p", fetchImpl: f.impl });
    assert.equal(f.calls[0]!.url, "https://gw/v1/images/generations");
    assert.equal(out.images[0]!.mimeType, "image/webp");
    assert.match(out.text, /Revised prompt: better/);
  });

  it("throws the provider's error message and when no image comes back", async () => {
    await assert.rejects(generate({ api: "fal", baseUrl: "", apiKey: "k", modelId: "m", prompt: "p", fetchImpl: fakeFetch(() => ({ detail: "bad model" }), 404).impl }), /404.*bad model/);
    await assert.rejects(generate({ api: "openrouter", baseUrl: "", apiKey: "k", modelId: "m", prompt: "p", fetchImpl: fakeFetch(() => ({ choices: [{ message: { content: "Here is your image!" } }] })).impl }), /returned no image. It said: Here is your image!/);
    await assert.rejects(generate({ api: "openrouter", baseUrl: "", apiKey: "", modelId: "m", prompt: "p" }), /No API key/);
  });
});

describe("routing", () => {
  const registry = {
    find: () => undefined,
    getAll: () => [{ provider: "gateway", id: "x", baseUrl: "https://router/v1" }],
    getApiKeyForProvider: async (p: string) => (p === "gateway" ? "ok" : undefined),
  };
  const noEndpoint = { baseUrl: "", apiKey: "", api: "openai-images" as const };

  it("routes by provider with the right key source", async () => {
    const or = await resolveRoute("openrouter/black-forest-labs/flux.2-klein-4b", noEndpoint, { ...DEFAULT_CONFIG, keys: { openrouter: "set", fal: "" } }, registry, {});
    assert.deepEqual([or.api, or.apiKey, or.modelId], ["openrouter", "set", "black-forest-labs/flux.2-klein-4b"]);
    const fal = await resolveRoute("fal/fal-ai/flux-2/klein/4b", noEndpoint, DEFAULT_CONFIG, registry, { FAL_KEY: "fk" });
    assert.deepEqual([fal.api, fal.apiKey, fal.modelId], ["fal", "fk", "fal-ai/flux-2/klein/4b"]);
    const omni = await resolveRoute("gateway/openrouter/black-forest-labs/flux.2-pro", noEndpoint, DEFAULT_CONFIG, registry, {});
    assert.deepEqual([omni.api, omni.baseUrl, omni.apiKey, omni.modelId], ["openai-images", "https://router/v1", "ok", "openrouter/black-forest-labs/flux.2-pro"]);
  });

  it("uses a custom endpoint with the model id as typed", async () => {
    const r = await resolveRoute("my-model", { baseUrl: "https://mine/v1", apiKey: "mk", api: "fal" }, DEFAULT_CONFIG, registry, {});
    assert.deepEqual([r.api, r.baseUrl, r.apiKey, r.modelId], ["fal", "https://mine/v1", "mk", "my-model"]);
  });

  it("says exactly what to set when a key is missing", async () => {
    await assert.rejects(resolveRoute("openrouter/x", noEndpoint, DEFAULT_CONFIG, registry, {}), /No OpenRouter key.*OPENROUTER_API_KEY/);
    await assert.rejects(resolveRoute("fal/x", noEndpoint, DEFAULT_CONFIG, registry, {}), /No fal key.*FAL_KEY/);
    await assert.rejects(resolveRoute("nowhere/x", noEndpoint, DEFAULT_CONFIG, registry, {}), /not configured in pi/);
  });
});

describe("catalog + vision", () => {
  it("keeps image-output models with their modalities", () => {
    const models = parseOpenRouterImageModels({ data: [
      { id: "black-forest-labs/flux.2-klein-4b", architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] } },
      { id: "google/gemini-3.1-flash-image", architecture: { input_modalities: ["image", "text", "file"], output_modalities: ["image", "text"] } },
      { id: "deepseek/v4", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "openrouter/auto", architecture: { output_modalities: ["image"] } },
    ] });
    assert.deepEqual(models.map((m) => [m.id, m.input, m.output]), [
      ["black-forest-labs/flux.2-klein-4b", ["text", "image"], ["image"]],
      ["google/gemini-3.1-flash-image", ["image", "text"], ["image", "text"]],
    ]);
  });

  it("hides image_recognize for vision models and restores it", () => {
    assert.deepEqual(applyRecognizeGating(["read", "image_recognize"], { id: "a", provider: "p", input: ["text", "image"] }, "image_recognize"), ["read"]);
    assert.deepEqual(applyRecognizeGating(["read"], { id: "a", provider: "p", input: ["text"] }, "image_recognize"), ["read", "image_recognize"]);
  });

  it("resolves vision models and rejects blind ones", () => {
    const reg = { find: () => undefined, getAll: () => [{ provider: "p", id: "eyes", input: ["text", "image"] }, { provider: "p", id: "blind", input: ["text"] }] };
    assert.equal((resolveVisionModel("p/eyes", reg) as { id: string }).id, "eyes");
    assert.match(resolveVisionModel("p/blind", reg) as string, /does not accept image input/);
  });

  it("saves images with a slugged, timestamped name", () => {
    const dir = mkdtempSync(join(tmpdir(), "unipi-img-"));
    const [file] = saveImages(dir, "A red cube!", [{ data: PNG, mimeType: "image/png" }], new Date("2026-09-28T01:02:03Z"));
    assert.match(file!, /2026-09-28_01-02-03-a-red-cube\.png$/);
    assert.equal(readFileSync(file!).toString(), "fake-png");
  });
});
