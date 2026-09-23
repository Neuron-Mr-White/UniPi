/**
 * Embedding endpoint resolution — pure resolver table per provider, plus the
 * $VAR key indirection and the /v1 URL convention (mirrors the judge).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  embeddingsUrl,
  resolveEnvApiKey,
  resolveEmbeddingEndpoint,
  type EmbeddingConfig,
  type RegistryReader,
} from "../settings.js";

const NO_REGISTRY: RegistryReader = () => undefined;

function config(overrides: Partial<EmbeddingConfig>): EmbeddingConfig {
  return {
    provider: "none",
    model: "openai/text-embedding-3-small",
    baseUrl: "",
    dimensions: 384,
    ...overrides,
  };
}

describe("embeddingsUrl (judge /v1 convention)", () => {
  it("version-segment bases are API roots; bare hosts get /v1 inserted", () => {
    assert.equal(embeddingsUrl("https://gw.example/v1"), "https://gw.example/v1/embeddings");
    assert.equal(embeddingsUrl("https://gw.example/api/v1/"), "https://gw.example/api/v1/embeddings");
    assert.equal(embeddingsUrl("https://gw.example"), "https://gw.example/v1/embeddings");
    assert.equal(embeddingsUrl("  https://gw.example  "), "https://gw.example/v1/embeddings");
  });
});

describe("resolveEnvApiKey ($VAR indirection, models.json convention)", () => {
  it("$NAME reads the env; literals pass through; missing env → undefined", () => {
    const env = { MY_KEY: "secret" };
    assert.equal(resolveEnvApiKey("$MY_KEY", env), "secret");
    assert.equal(resolveEnvApiKey("literal-key", env), "literal-key");
    assert.equal(resolveEnvApiKey("$MISSING", env), undefined);
    assert.equal(resolveEnvApiKey(undefined, env), undefined);
  });
});

describe("resolveEmbeddingEndpoint per provider", () => {
  it("none → null (fuzzy-only)", () => {
    assert.equal(resolveEmbeddingEndpoint(config({ provider: "none" }), NO_REGISTRY), null);
  });

  it("openrouter → fixed URL; config key wins, then env fallbacks", () => {
    const env = { OPENROUTER_API_KEY: "env-key" };
    const ep = resolveEmbeddingEndpoint(config({ provider: "openrouter", apiKey: "cfg-key" }), NO_REGISTRY, env);
    assert.equal(ep?.url, "https://openrouter.ai/api/v1/embeddings");
    assert.equal(ep?.apiKey, "cfg-key");
    assert.equal(
      resolveEmbeddingEndpoint(config({ provider: "openrouter" }), NO_REGISTRY, env)?.apiKey,
      "env-key",
    );
    assert.equal(
      resolveEmbeddingEndpoint(config({ provider: "openrouter" }), NO_REGISTRY, {
        OPEN_ROUTER_API_KEY: "alt",
      })?.apiKey,
      "alt",
    );
  });

  it("custom → baseUrl required; /v1 rule; config key then env", () => {
    assert.equal(resolveEmbeddingEndpoint(config({ provider: "custom", baseUrl: "" }), NO_REGISTRY), null);
    assert.equal(resolveEmbeddingEndpoint(config({ provider: "custom", baseUrl: "   " }), NO_REGISTRY), null);
    const ep = resolveEmbeddingEndpoint(
      config({ provider: "custom", baseUrl: "https://gw.example/v1", apiKey: "k" }),
      NO_REGISTRY,
    );
    assert.equal(ep?.url, "https://gw.example/v1/embeddings");
    assert.equal(ep?.apiKey, "k");
    assert.equal(
      resolveEmbeddingEndpoint(
        config({ provider: "custom", baseUrl: "https://gw.example" }),
        NO_REGISTRY,
        { OPENROUTER_API_KEY: "env-k" },
      )?.url,
      "https://gw.example/v1/embeddings",
    );
  });

  it("inherit → registry provider baseUrl + $VAR/literal key resolution", () => {
    const reader: RegistryReader = (provider) =>
      provider === "omniroute"
        ? { baseUrl: "https://router.oino.dev/v1", apiKey: "$OMNI_API_KEY" }
        : provider === "local"
          ? { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "none" }
          : undefined;
    const env = { OMNI_API_KEY: "omni-secret" };

    const viaEnv = resolveEmbeddingEndpoint(
      config({ provider: "inherit", model: "omniroute/openai/text-embedding-3-small" }),
      reader,
      env,
    );
    assert.equal(viaEnv?.url, "https://router.oino.dev/v1/embeddings");
    assert.equal(viaEnv?.apiKey, "omni-secret", "$VAR name resolved through the environment");

    const literal = resolveEmbeddingEndpoint(
      config({ provider: "inherit", model: "local/qwen-27b" }),
      reader,
      env,
    );
    assert.equal(literal?.url, "http://127.0.0.1:8080/v1/embeddings");
    assert.equal(literal?.apiKey, "none", "literal keys pass through");
  });

  it("inherit is unconfigured without a provider segment or registry entry", () => {
    assert.equal(
      resolveEmbeddingEndpoint(config({ provider: "inherit", model: "no-slash" }), NO_REGISTRY),
      null,
    );
    assert.equal(
      resolveEmbeddingEndpoint(
        config({ provider: "inherit", model: "ghost/m1" }),
        NO_REGISTRY,
      ),
      null,
      "unknown registry provider → no endpoint",
    );
    assert.equal(
      resolveEmbeddingEndpoint(
        config({ provider: "inherit", model: "ghost/m1" }),
        () => ({ apiKey: "$K" }),
      ),
      null,
      "provider without baseUrl → no endpoint",
    );
  });

  it("missing env for a $VAR registry key yields an endpoint with no key (not ready)", () => {
    const ep = resolveEmbeddingEndpoint(
      config({ provider: "inherit", model: "omniroute/m1" }),
      () => ({ baseUrl: "https://router.oino.dev/v1", apiKey: "$OMNI_API_KEY" }),
      {},
    );
    assert.equal(ep?.url, "https://router.oino.dev/v1/embeddings");
    assert.equal(ep?.apiKey, undefined);
  });
});
