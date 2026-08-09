/**
 * Tests for bridging pi's chat providers into pi-ai's images collection.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groupModelsByProvider } from "../src/register-providers.js";
import type { ImageGenModel } from "../src/models.js";

function model(provider: string, id: string, baseUrl?: string): ImageGenModel {
  return { provider, id, api: "", ...(baseUrl ? { baseUrl } : {}) };
}

describe("groupModelsByProvider", () => {
  it("groups by provider and inherits the provider baseUrl", () => {
    const grouped = groupModelsByProvider(
      [model("omniroute", "a/flux"), model("omniroute", "b/imagen")],
      (p) => (p === "omniroute" ? "https://router.example/v1" : undefined),
    );

    assert.equal(grouped.size, 1);
    const entry = grouped.get("omniroute");
    assert.equal(entry?.models.length, 2);
    // Each model carries the resolved endpoint, so the adapter never has to
    // look it up again.
    assert.equal(entry?.models[0]?.baseUrl, "https://router.example/v1");
    assert.equal(entry?.models[1]?.baseUrl, "https://router.example/v1");
  });

  it("prefers a baseUrl already on the model", () => {
    const grouped = groupModelsByProvider(
      [model("p", "m", "https://explicit/v1")],
      () => "https://fallback/v1",
    );
    assert.equal(grouped.get("p")?.models[0]?.baseUrl, "https://explicit/v1");
  });

  it("skips providers with no resolvable endpoint", () => {
    // Registering these would guarantee a request failure later.
    const grouped = groupModelsByProvider([model("nowhere", "m")], () => undefined);
    assert.equal(grouped.size, 0);
  });

  it("keeps distinct providers separate", () => {
    const grouped = groupModelsByProvider(
      [model("a", "m1", "https://a/v1"), model("b", "m2", "https://b/v1")],
      () => undefined,
    );
    assert.deepEqual([...grouped.keys()].sort(), ["a", "b"]);
  });
});

/**
 * The endpoint must survive discovery.
 *
 * `listRegistryImageGenModels` originally rebuilt each model from a field list
 * that omitted `baseUrl`. Registration still succeeded, so everything looked
 * fine until the first real call failed with "No baseUrl for image model ...".
 */
describe("baseUrl propagation", () => {
  it("keeps a registry model's baseUrl through discovery", async () => {
    const { listRegistryImageGenModels } = await import("../src/models.js");

    const registry = {
      find: () => undefined,
      getAll: () => [
        {
          id: "black-forest-labs/flux.2-pro",
          provider: "omniroute",
          baseUrl: "https://router.example/v1",
          api: "openai-completions",
        },
      ],
      getAvailable: undefined,
    };

    const found = listRegistryImageGenModels(registry as never);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.baseUrl, "https://router.example/v1");
  });

  it("finds a provider baseUrl for a model that has none", async () => {
    const { findProviderBaseUrl } = await import("../src/models.js");

    const registry = {
      find: () => undefined,
      getAll: () => [
        { id: "chat-1", provider: "omniroute", baseUrl: "https://router.example/v1" },
      ],
    };

    assert.equal(
      findProviderBaseUrl(registry as never, "omniroute"),
      "https://router.example/v1",
    );
    assert.equal(findProviderBaseUrl(registry as never, "absent"), undefined);
    assert.equal(findProviderBaseUrl(undefined, "omniroute"), undefined);
  });
});
