/**
 * Core jev client — transport selection, URL/payload shape, answer parsing,
 * and the fail-open contract for both native typesafe and openrouter
 * decisions endpoints. All fetches are stubbed; no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  askJev,
  isJevDecisionsModel,
  jevApiKey,
  jevDecisionsUrl,
  jevSystemoneUrl,
  type FetchLike,
  type JevSettings,
} from "../client.js";

const ok = (body: unknown): FetchLike => async () =>
  new Response(JSON.stringify(body), { status: 200 });

const base: JevSettings = {
  provider: "typesafe",
  model: "jev-latest",
  baseUrl: "",
  apiKey: "",
};

describe("jev URL builders", () => {
  it("native typesafe uses /v1/systemone; gateways use the version-root rule", () => {
    assert.equal(jevSystemoneUrl(base), "https://api.typesafe.ai/v1/systemone");
    assert.equal(jevDecisionsUrl({ ...base, provider: "openrouter" }), "https://openrouter.ai/api/alpha/decisions");
    assert.equal(
      jevDecisionsUrl({ ...base, provider: "custom", baseUrl: "https://gw.example/v1" }),
      "https://gw.example/v1/decisions",
    );
    assert.equal(
      jevDecisionsUrl({ ...base, provider: "custom", baseUrl: "https://gw.example/" }),
      "https://gw.example/api/alpha/decisions",
      "bare hosts get openrouter's /api/alpha prefix (judge decisionsUrl rule)",
    );
  });

  it("decision-model shape detection matches the judge", () => {
    assert.ok(isJevDecisionsModel("typesafe/jev-1.13"));
    assert.ok(isJevDecisionsModel("anything-jev"));
    assert.ok(!isJevDecisionsModel("zai/glm-5.3-flash"));
  });
});

describe("askJev — native typesafe", () => {
  it("POSTs systemone payload and parses answers", async () => {
    const calls: Array<{ url: string; body: unknown; auth?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) });
      return new Response(JSON.stringify({ answers: { s0: { noul: 0.9 } } }), { status: 200 });
    };
    const answers = await askJev({
      state: "fix a css bug",
      questions: { s0: { type: "noul" } },
      settings: { ...base, apiKey: "k" },
      fetchImpl,
      env: {},
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
    assert.deepEqual(calls[0]!.body, { state: "fix a css bug", model: "jev-latest", questions: { s0: { type: "noul" } } });
    assert.equal(calls[0]!.auth, "Bearer k");
    assert.equal(answers?.s0?.noul, 0.9);
  });

  it("missing key → null without a fetch; non-ok → null; bad shape → null", async () => {
    let calls = 0;
    const counting: FetchLike = async () => { calls++; return new Response("{}", { status: 200 }); };
    assert.equal(await askJev({ state: "s", questions: {}, settings: { ...base }, fetchImpl: counting, env: {} }), null, "no key anywhere");
    assert.equal(calls, 0);
    assert.equal(await askJev({ state: "s", questions: {}, settings: { ...base, apiKey: "k" }, fetchImpl: async () => new Response("x", { status: 500 }) }), null);
    assert.equal(await askJev({ state: "s", questions: {}, settings: { ...base, apiKey: "k" }, fetchImpl: ok({ nope: 1 }) }), null);
  });

  it("env TYPESAFE_API_KEY is used when no stored key", async () => {
    let auth = "";
    const answers = await askJev({
      state: "s", questions: {},
      settings: { ...base },
      fetchImpl: async (url, init) => { auth = String((init.headers as Record<string, string>).authorization); return ok({ answers: {} })(); },
      env: { TYPESAFE_API_KEY: "env-k" },
    });
    assert.equal(auth, "Bearer env-k");
    assert.deepEqual(answers, {});
  });
});

describe("askJev — openrouter decisions", () => {
  it("jev model → decisions endpoint with stored key winning over env", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const settings: JevSettings = {
      provider: "openrouter", model: "typesafe/jev-1.13", baseUrl: "", apiKey: "stored", timeoutMs: 5_000,
    };
    const answers = await askJev({
      state: "state text",
      questions: { s0: { type: "noul" } },
      settings,
      fetchImpl: async (url, init) => {
        calls.push({ url, auth: String((init.headers as Record<string, string>).authorization) });
        return new Response(JSON.stringify({ answers: { s0: { noul: 0.4 } } }), { status: 200 });
      },
      env: { OPENROUTER_API_KEY: "env-k" },
    });
    assert.equal(calls[0]!.url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(calls[0]!.auth, "Bearer stored", "stored key wins");
    assert.equal(answers?.s0?.noul, 0.4);
  });

  it("non-jev chat model is unsupported here → null (chat fallback stays in long-horizon)", async () => {
    let calls = 0;
    const answers = await askJev({
      state: "s", questions: {},
      settings: { ...base, provider: "openrouter", model: "zai/glm-5.3-flash", apiKey: "k" },
      fetchImpl: async () => { calls++; return new Response("{}", { status: 200 }); },
      env: {},
    });
    assert.equal(answers, null);
    assert.equal(calls, 0);
  });

  it("custom without baseUrl → null", async () => {
    const answers = await askJev({
      state: "s", questions: {},
      settings: { ...base, provider: "custom", model: "typesafe/jev-1.13", baseUrl: "  ", apiKey: "k" },
      fetchImpl: async () => new Response("{}", { status: 200 }),
      env: {},
    });
    assert.equal(answers, null);
  });

  it("timeout aborts the call → null", async () => {
    const answers = await askJev({
      state: "s", questions: {},
      settings: { ...base, apiKey: "k", timeoutMs: 30 },
      fetchImpl: (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      env: {},
    });
    assert.equal(answers, null);
  });

  it("external signal aborts the call → null", async () => {
    const controller = new AbortController();
    const answers = await askJev({
      state: "s", questions: {},
      settings: { ...base, apiKey: "k", timeoutMs: 30_000 },
      signal: controller.signal,
      fetchImpl: (_url, init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      env: {},
    });
    controller.abort();
    assert.equal(answers, null);
  });
});
