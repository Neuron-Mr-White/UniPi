/**
 * Image-generation model discovery across providers.
 *
 * Regression cover for the bug where the settings picker only ever offered
 * pi-ai's built-in OpenRouter catalog, so image models contributed by other
 * extensions (pi-omniroute-bridge and friends) were unreachable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __setImagesModelsForTests,
  formatModelRef,
  listAllImageGenModels,
  listRegistryImageGenModels,
  looksLikeImageGenerator,
  type ChatModelRegistry,
  type ImageGenModel,
} from "../src/models.js";

function registryOf(models: unknown[]): ChatModelRegistry {
  return {
    find: () => undefined,
    getAll: () => models,
    getAvailable: () => models,
  };
}

function imagesApiOf(models: ImageGenModel[]) {
  return {
    getModels: () => models,
    getModel: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAuth: async () => ({ apiKey: "k" }),
    generateImages: async () => ({ output: [], stopReason: "stop" }),
  };
}

const BUILTIN: ImageGenModel[] = [
  { provider: "openrouter", id: "google/gemini-3-pro-image", api: "openrouter-images" },
  { provider: "openrouter", id: "black-forest-labs/flux.2-pro", api: "openrouter-images" },
];

// ─── Generator detection ─────────────────────────────────────────────

test("detects generators declared with an explicit image output", () => {
  assert.equal(
    looksLikeImageGenerator({ id: "some/model", output: ["image"] }),
    true,
  );
});

test("trusts an explicit text-only output over a suggestive name", () => {
  // Declaring output:["text"] means it is a chat model, even if it is called
  // something image-ish. Guessing from the name here would be wrong.
  assert.equal(
    looksLikeImageGenerator({ id: "vendor/flux-chat", output: ["text"] }),
    false,
  );
});

test("recognises text-to-image endpoints that declare no output modality", () => {
  // This is the omniroute shape: real generators with output === undefined.
  const ids = [
    "fal/bria/text-to-image/3.2",
    "fal/fal-ai/flux-2-pro",
    "fal/fal-ai/recraft/v4/text-to-image",
    "fal/fal-ai/bytedance/seedream/v4.5/text-to-image",
    "openai/gpt-5-image",
    "x-ai/grok-imagine-image-quality",
  ];
  for (const id of ids) {
    assert.equal(looksLikeImageGenerator({ id }), true, `${id} should be a generator`);
  }
});

test("does not mistake vision chat models for generators", () => {
  const ids = [
    "antigravity/claude-opus-4-6-thinking",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5",
    "google/gemini-3-pro",
  ];
  for (const id of ids) {
    assert.equal(looksLikeImageGenerator({ id }), false, `${id} is not a generator`);
  }
});

// ─── Registry discovery ──────────────────────────────────────────────

test("finds generators among registered provider models", () => {
  const registry = registryOf([
    { provider: "omniroute", id: "fal/fal-ai/flux-2-pro", input: ["text"] },
    { provider: "omniroute", id: "antigravity/claude-sonnet-4-6", input: ["text", "image"] },
    { provider: "omniroute", id: "fal/bria/text-to-image/3.2", input: ["text"] },
  ]);

  const found = listRegistryImageGenModels(registry).map(formatModelRef);
  assert.deepEqual(found, [
    "omniroute/fal/fal-ai/flux-2-pro",
    "omniroute/fal/bria/text-to-image/3.2",
  ]);
});

test("skips malformed registry entries without throwing", () => {
  const registry = registryOf([
    null,
    "nonsense",
    { id: "no-provider" },
    { provider: "p", id: 42 },
    { provider: "omniroute", id: "fal/fal-ai/flux-2-max", input: ["text"] },
  ]);
  assert.deepEqual(listRegistryImageGenModels(registry).map(formatModelRef), [
    "omniroute/fal/fal-ai/flux-2-max",
  ]);
});

test("survives a registry that throws", () => {
  const hostile: ChatModelRegistry = {
    find: () => undefined,
    getAll: () => {
      throw new Error("boom");
    },
    getAvailable: () => {
      throw new Error("boom");
    },
  };
  assert.deepEqual(listRegistryImageGenModels(hostile), []);
});

// ─── Merged listing ──────────────────────────────────────────────────

test("merges built-in and registry models", async () => {
  __setImagesModelsForTests(imagesApiOf(BUILTIN));
  const registry = registryOf([
    { provider: "omniroute", id: "fal/fal-ai/flux-2-pro", input: ["text"] },
  ]);

  const all = (await listAllImageGenModels(registry)).map(formatModelRef);
  assert.ok(all.includes("openrouter/google/gemini-3-pro-image"));
  assert.ok(
    all.includes("omniroute/fal/fal-ai/flux-2-pro"),
    "registry-provided generators must be selectable",
  );
  __setImagesModelsForTests(null);
});

test("de-duplicates a model offered by both sources", async () => {
  __setImagesModelsForTests(imagesApiOf(BUILTIN));
  const registry = registryOf([
    { provider: "openrouter", id: "google/gemini-3-pro-image", input: ["text"] },
  ]);

  const all = await listAllImageGenModels(registry);
  const matches = all.filter(
    (m) => formatModelRef(m) === "openrouter/google/gemini-3-pro-image",
  );
  assert.equal(matches.length, 1);
  __setImagesModelsForTests(null);
});

test("still works with no registry at all", async () => {
  __setImagesModelsForTests(imagesApiOf(BUILTIN));
  const all = await listAllImageGenModels(null);
  assert.equal(all.length, BUILTIN.length);
  __setImagesModelsForTests(null);
});

test("returns registry models even when pi-ai's catalog is unavailable", async () => {
  // No OpenRouter key / older pi-ai: the built-in catalog is empty, but a
  // registered provider's generators must still be offered.
  __setImagesModelsForTests(imagesApiOf([]));
  const registry = registryOf([
    { provider: "omniroute", id: "fal/fal-ai/flux-2-pro", input: ["text"] },
  ]);
  const all = (await listAllImageGenModels(registry)).map(formatModelRef);
  assert.deepEqual(all, ["omniroute/fal/fal-ai/flux-2-pro"]);
  __setImagesModelsForTests(null);
});

// ─── Custom / explicit model references ──────────────────────────────

import { resolveImageGenModel, resolveVisionModel } from "../src/models.js";

test("accepts an explicit provider/model-id absent from the catalog", () => {
  // Detection is heuristic; a user-supplied reference must not be refused.
  const resolved = resolveImageGenModel("omniroute/fal/fal-ai/brand-new", BUILTIN);
  assert.notEqual(typeof resolved, "string");
  assert.equal(formatModelRef(resolved as ImageGenModel), "omniroute/fal/fal-ai/brand-new");
});

test("accepts an explicit reference when the catalog is empty", () => {
  const resolved = resolveImageGenModel("omniroute/fal/fal-ai/flux-2-pro", []);
  assert.notEqual(typeof resolved, "string");
  assert.equal(formatModelRef(resolved as ImageGenModel), "omniroute/fal/fal-ai/flux-2-pro");
});

test("still reports a bare typo with the available list", () => {
  // No provider segment ⇒ a mistake, not a deliberate custom reference.
  const resolved = resolveImageGenModel("gemin", BUILTIN);
  // "gemin" fuzzy-matches the real gemini model, so use something unmatchable.
  assert.ok(resolved);
  const bad = resolveImageGenModel("zzzznope", BUILTIN);
  assert.equal(typeof bad, "string");
  assert.match(bad as string, /Unknown image model/);
});

test("prefers a catalog match over treating input as a custom reference", () => {
  const resolved = resolveImageGenModel("openrouter/google/gemini-3-pro-image", BUILTIN);
  assert.notEqual(typeof resolved, "string");
  assert.equal((resolved as ImageGenModel).api, "openrouter-images", "must be the catalog entry");
});

test("vision: accepts an explicit reference the registry does not know", () => {
  const registry = registryOf([
    { provider: "omniroute", id: "antigravity/claude-sonnet-4-6", input: ["text", "image"] },
  ]);
  const resolved = resolveVisionModel("omniroute/some/new-vision-model", registry);
  assert.notEqual(typeof resolved, "string");
  assert.equal(formatModelRef(resolved as any), "omniroute/some/new-vision-model");
});

test("vision: a registered text-only model is still rejected clearly", () => {
  // The precise error must win over the custom-reference fallback.
  const registry = registryOf([
    { provider: "omniroute", id: "vision/ok", input: ["text", "image"] },
    { provider: "omniroute", id: "text/only", input: ["text"] },
  ]);
  const resolved = resolveVisionModel("omniroute/text/only", registry);
  assert.equal(typeof resolved, "string");
  assert.match(resolved as string, /does not accept image input/);
});

// ─── Generation provider capability ──────────────────────────────────

/**
 * pi-ai's images collection has its OWN provider set (currently just
 * `openrouter`), entirely separate from pi's chat model registry. A chat
 * provider registered by another extension can therefore list image models
 * that generation cannot drive — pi-ai answers with a bare
 * "Unknown provider: omniroute". These pin the friendlier behaviour.
 */

import { generateImage } from "../src/generate.js";

test("rejects a provider the images collection cannot generate with", async () => {
  await assert.rejects(
    () =>
      generateImage({
        prompt: "a hexagon",
        model: { provider: "omniroute", id: "fal/fal-ai/flux-2-pro", api: "" },
        images: imagesApiOf(BUILTIN),
      }),
    (err: Error) => {
      assert.match(err.message, /no image-generation route/);
      assert.match(err.message, /openrouter/);
      assert.match(err.message, /image-settings/);
      return true;
    },
  );
});

test("allows a provider the images collection does support", async () => {
  // Must reach the API rather than being blocked by the capability check.
  const api = {
    ...imagesApiOf(BUILTIN),
    generateImages: async () => ({
      output: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      stopReason: "stop",
    }),
  };
  const result = await generateImage({
    prompt: "a hexagon",
    model: BUILTIN[0],
    images: api as never,
  });
  assert.equal(result.images.length, 1);
});

test("does not block generation when the catalog is empty", async () => {
  // Unknown capability ⇒ permissive; the real call reports its own error.
  const api = {
    ...imagesApiOf([]),
    generateImages: async () => ({
      output: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      stopReason: "stop",
    }),
  };
  const result = await generateImage({
    prompt: "x",
    model: { provider: "anything", id: "some/model", api: "" },
    images: api as never,
  });
  assert.equal(result.images.length, 1);
});
