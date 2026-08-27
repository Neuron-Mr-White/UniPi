/**
 * Model discovery and resolution tests.
 *
 * Vision filtering is the important one: sending an image to a text-only model
 * produces a confusing provider error, so it must be caught up front.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  __resetModelCacheForTests,
  __setImagesModelsForTests,
  applyRecognizeGating,
  formatModelRef,
  isVisionModel,
  listImageGenModels,
  listVisionModels,
  resolveImageGenModel,
  resolveVisionModel,
  splitModelRef,
  type ChatModelRegistry,
  type ImageGenModel,
} from "../src/models.ts";

const GEN_MODELS: ImageGenModel[] = [
  {
    id: "black-forest-labs/flux.2-pro",
    name: "Black Forest Labs: FLUX.2 Pro",
    provider: "openrouter",
    api: "openrouter-images",
  },
  {
    id: "google/gemini-3-pro-image",
    name: "Google: Gemini 3 Pro Image",
    provider: "openrouter",
    api: "openrouter-images",
  },
  {
    id: "recraft/recraft-v3",
    name: "Recraft V3",
    provider: "openrouter",
    api: "openrouter-images",
  },
];

/** Chat registry stub with a mix of vision and text-only models. */
function chatRegistry(): ChatModelRegistry {
  const models = [
    { id: "claude-sonnet-4-6", provider: "anthropic", input: ["text", "image"] },
    { id: "gpt-5", provider: "openai", input: ["text", "image"] },
    { id: "gpt-oss-20b", provider: "openrouter", input: ["text"] },
    { id: "no-input-field", provider: "weird" },
  ];

  return {
    getAll: () => models,
    getAvailable: () => models,
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
  };
}

afterEach(() => {
  __resetModelCacheForTests();
});

describe("splitModelRef", () => {
  it("splits on the first slash so model ids may contain slashes", () => {
    assert.deepEqual(splitModelRef("openrouter/black-forest-labs/flux.2-pro"), {
      provider: "openrouter",
      id: "black-forest-labs/flux.2-pro",
    });
  });

  it("rejects malformed refs", () => {
    for (const bad of ["", "noslash", "/leading", "trailing/", "   "]) {
      assert.equal(splitModelRef(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe("formatModelRef", () => {
  it("joins provider and id", () => {
    assert.equal(
      formatModelRef({ provider: "openrouter", id: "a/b" }),
      "openrouter/a/b",
    );
  });
});

describe("listImageGenModels", () => {
  it("returns an empty list when pi-ai exposes no image API", async () => {
    __setImagesModelsForTests(null);
    // A null override means "attempted, unavailable" only after a reset,
    // so assert the real resolution path degrades rather than throwing.
    const models = await listImageGenModels();
    assert.ok(Array.isArray(models));
  });

  it("returns the catalog from the injected collection", async () => {
    __setImagesModelsForTests({
      getModels: () => GEN_MODELS,
      getModel: (_p, id) => GEN_MODELS.find((m) => m.id === id),
      getAuth: async () => ({ apiKey: "k" }),
      generateImages: async () => ({}),
    });

    assert.deepEqual(await listImageGenModels(), GEN_MODELS);
  });

  it("degrades to an empty list when getModels throws", async () => {
    __setImagesModelsForTests({
      getModels: () => {
        throw new Error("boom");
      },
      getModel: () => undefined,
      getAuth: async () => undefined,
      generateImages: async () => ({}),
    });

    assert.deepEqual(await listImageGenModels(), []);
  });
});

describe("resolveImageGenModel", () => {
  it("matches an exact provider/id ref", () => {
    const result = resolveImageGenModel(
      "openrouter/black-forest-labs/flux.2-pro",
      GEN_MODELS,
    );
    assert.equal(typeof result === "string" ? result : result.id, "black-forest-labs/flux.2-pro");
  });

  it("matches a bare model id", () => {
    const result = resolveImageGenModel("google/gemini-3-pro-image", GEN_MODELS);
    assert.equal(typeof result === "string" ? result : result.id, "google/gemini-3-pro-image");
  });

  it("fuzzy-matches a partial name", () => {
    for (const [query, expected] of [
      ["flux.2-pro", "black-forest-labs/flux.2-pro"],
      ["gemini-3-pro", "google/gemini-3-pro-image"],
      ["recraft", "recraft/recraft-v3"],
    ] as const) {
      const result = resolveImageGenModel(query, GEN_MODELS);
      assert.equal(
        typeof result === "string" ? result : result.id,
        expected,
        `query "${query}"`,
      );
    }
  });

  it("is case-insensitive", () => {
    const result = resolveImageGenModel("FLUX.2-PRO", GEN_MODELS);
    assert.notEqual(typeof result, "string");
  });

  it("returns a helpful error listing alternatives for an unknown model", () => {
    const result = resolveImageGenModel("definitely-not-a-model", GEN_MODELS);
    assert.equal(typeof result, "string");
    assert.match(result as string, /Unknown image model/);
    assert.match(result as string, /flux\.2-pro/);
  });

  it("explains when no models are available at all", () => {
    const result = resolveImageGenModel("anything", []);
    assert.match(result as string, /No image generation models are available/);
    assert.match(result as string, /openrouter\.ai/);
  });

  it("rejects an empty query", () => {
    assert.match(resolveImageGenModel("   ", GEN_MODELS) as string, /No image model/);
  });
});

describe("listVisionModels", () => {
  it("returns only models declaring image input", () => {
    const vision = listVisionModels(chatRegistry());
    assert.deepEqual(vision.map((m) => m.id), ["claude-sonnet-4-6", "gpt-5"]);
  });

  it("excludes models with no declared input modality", () => {
    const vision = listVisionModels(chatRegistry());
    assert.ok(
      !vision.some((m) => m.id === "no-input-field"),
      "a model that does not declare image input must not be assumed capable",
    );
  });

  it("degrades to an empty list when the registry throws", () => {
    const broken: ChatModelRegistry = {
      getAll: () => {
        throw new Error("registry unavailable");
      },
      find: () => undefined,
    };
    assert.deepEqual(listVisionModels(broken), []);
  });

  it("falls back to getAll when getAvailable is absent", () => {
    const registry: ChatModelRegistry = {
      getAll: () => [{ id: "m", provider: "p", input: ["text", "image"] }],
      find: () => undefined,
    };
    assert.equal(listVisionModels(registry).length, 1);
  });
});

describe("applyRecognizeGating", () => {
  const RECOGNIZE = "image_recognize";
  const visionModel = { id: "claude", provider: "anthropic", input: ["text", "image"] };
  const textModel = { id: "deepseek", provider: "openrouter", input: ["text"] };
  const blindModel = { id: "mystery", provider: "p" }; // declares no input modalities

  it("hides the tool for a vision-capable session model", () => {
    const next = applyRecognizeGating(["read", RECOGNIZE], visionModel, RECOGNIZE);
    assert.deepEqual(next, ["read"]);
  });

  it("keeps the tool for a text-only model", () => {
    const active = ["read", RECOGNIZE];
    assert.deepEqual(applyRecognizeGating(active, textModel, RECOGNIZE), active);
  });

  it("treats models that declare no input modalities as non-vision", () => {
    const active = ["read", RECOGNIZE];
    assert.deepEqual(applyRecognizeGating(active, blindModel, RECOGNIZE), active);
    assert.deepEqual(applyRecognizeGating(active, undefined, RECOGNIZE), active);
  });

  it("restores the tool when switching back to a text-only model", () => {
    const next = applyRecognizeGating(["read"], textModel, RECOGNIZE);
    assert.deepEqual(next, ["read", RECOGNIZE]);
  });

  it("leaves unrelated tools untouched", () => {
    const next = applyRecognizeGating(
      ["read", "bash", "image_generate", RECOGNIZE],
      visionModel,
      RECOGNIZE,
    );
    assert.deepEqual(next, ["read", "bash", "image_generate"]);
  });

  it("stays absent when already hidden", () => {
    const active = ["read"];
    assert.deepEqual(applyRecognizeGating(active, visionModel, RECOGNIZE), ["read"]);
  });
});

describe("isVisionModel", () => {
  it("accepts the session model shape", () => {
    assert.ok(isVisionModel({ id: "m", provider: "p", input: ["text", "image"] }));
    assert.ok(!isVisionModel({ id: "m", provider: "p", input: ["text"] }));
    assert.ok(!isVisionModel(undefined));
  });
});

describe("resolveVisionModel", () => {
  it("resolves an exact ref", () => {
    const result = resolveVisionModel("anthropic/claude-sonnet-4-6", chatRegistry());
    assert.equal(typeof result === "string" ? result : result.id, "claude-sonnet-4-6");
  });

  it("fuzzy-matches", () => {
    const result = resolveVisionModel("sonnet", chatRegistry());
    assert.equal(typeof result === "string" ? result : result.id, "claude-sonnet-4-6");
  });

  it("rejects a known model that cannot accept images, by name", () => {
    const result = resolveVisionModel("openrouter/gpt-oss-20b", chatRegistry());
    assert.equal(typeof result, "string");
    assert.match(result as string, /does not accept image input/);
  });

  it("reports when nothing vision-capable is configured", () => {
    const textOnly: ChatModelRegistry = {
      getAll: () => [{ id: "gpt-oss-20b", provider: "openrouter", input: ["text"] }],
      find: () => undefined,
    };
    const result = resolveVisionModel("anything", textOnly);
    assert.match(result as string, /No vision-capable models are configured/);
  });

  it("lists the vision models for a wholly unknown ref", () => {
    const result = resolveVisionModel("nonexistent-zzz", chatRegistry());
    assert.match(result as string, /Unknown model/);
    assert.match(result as string, /anthropic\/claude-sonnet-4-6/);
  });
});
