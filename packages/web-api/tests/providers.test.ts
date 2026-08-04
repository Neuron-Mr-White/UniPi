/**
 * Provider registry and ranking tests.
 *
 * Ranking collisions are silent and dangerous: `selectProvider` matches on the
 * exact rank number and `getProviderByRank` uses `.find`, so a duplicate rank
 * shadows a provider with no error anywhere. These tests pin the rank map so
 * adding a provider cannot quietly break `source:` selection.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { registry } from "../src/providers/registry.ts";
import type { WebCapability } from "../src/providers/base.ts";

// Registration is an import side effect, mirroring src/index.ts.
before(async () => {
  await import("../src/providers/wigolo.ts");
  await import("../src/providers/duckduckgo.ts");
  await import("../src/providers/jina-search.ts");
  await import("../src/providers/jina-reader.ts");
  await import("../src/providers/serpapi.ts");
  await import("../src/providers/tavily.ts");
  await import("../src/providers/firecrawl.ts");
  await import("../src/providers/perplexity.ts");
  await import("../src/providers/llm-summarize.ts");
});

const CAPABILITIES: WebCapability[] = ["search", "read", "summarize"];

describe("provider registry", () => {
  it("registers every provider exactly once", () => {
    const ids = registry.getAllProviders().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate provider ids");
    assert.ok(ids.includes("wigolo"), "wigolo must be registered");
  });

  it("declares a ranking for all three capabilities", () => {
    for (const provider of registry.getAllProviders()) {
      for (const capability of CAPABILITIES) {
        assert.equal(
          typeof provider.ranking[capability],
          "number",
          `${provider.id} is missing a ${capability} ranking`,
        );
      }
    }
  });

  it("implements every capability it declares", () => {
    for (const provider of registry.getAllProviders()) {
      for (const capability of provider.capabilities) {
        assert.equal(
          typeof provider[capability],
          "function",
          `${provider.id} declares ${capability} but does not implement it`,
        );
        assert.ok(
          provider.ranking[capability] > 0,
          `${provider.id} declares ${capability} but ranks it 0 (unsupported)`,
        );
      }
    }
  });

  it("has no duplicate ranks within a capability", () => {
    for (const capability of CAPABILITIES) {
      const ranks = registry
        .getRankedProviders(capability)
        .map((p) => p.ranking[capability]);
      assert.deepEqual(
        ranks,
        [...new Set(ranks)],
        `duplicate ${capability} ranks: ${ranks.join(", ")} — source selection would silently shadow a provider`,
      );
    }
  });

  it("uses contiguous ranks starting at 1", () => {
    for (const capability of CAPABILITIES) {
      const ranks = registry
        .getRankedProviders(capability)
        .map((p) => p.ranking[capability]);
      assert.deepEqual(
        ranks,
        ranks.map((_, i) => i + 1),
        `${capability} ranks must be 1..n with no gaps, got ${ranks.join(", ")}`,
      );
    }
  });
});

describe("capability rank map", () => {
  it("ranks wigolo first for search and read", () => {
    const wigolo = registry.getProvider("wigolo");
    assert.ok(wigolo, "wigolo provider not found");
    assert.equal(wigolo.ranking.search, 1, "wigolo must be the default search provider");
    assert.equal(wigolo.ranking.read, 1, "wigolo must be the default read provider");
    assert.equal(wigolo.requiresApiKey, false, "wigolo is keyless");
  });

  it("pins the documented search order", () => {
    assert.deepEqual(
      registry.getRankedProviders("search").map((p) => p.id),
      ["wigolo", "duckduckgo", "jina-search", "serpapi", "tavily", "perplexity"],
      "search order must match the tool's `source` parameter documentation",
    );
  });

  it("pins the documented read order", () => {
    assert.deepEqual(
      registry.getRankedProviders("read").map((p) => p.id),
      ["wigolo", "jina-reader", "firecrawl", "perplexity"],
      "read order must match the tool's `source` parameter documentation",
    );
  });

  it("reserves read rank 0 for the built-in smart-fetch engine", () => {
    const readProviders = registry.getProvidersForCapability("read");
    for (const provider of readProviders) {
      assert.notEqual(
        provider.ranking.read,
        0,
        `${provider.id} claims read rank 0, reserved for smart-fetch`,
      );
    }
  });

  it("resolves a provider by rank", () => {
    assert.equal(registry.getProviderByRank("search", 1)?.id, "wigolo");
    assert.equal(registry.getProviderByRank("search", 2)?.id, "duckduckgo");
    assert.equal(registry.getProviderByRank("read", 2)?.id, "jina-reader");
    assert.equal(registry.getProviderByRank("search", 99), undefined);
  });
});
