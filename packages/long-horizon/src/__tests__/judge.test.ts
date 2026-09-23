import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../settings.js";
import { askJudge, buildQuestions, createTypesafeTransport } from "../judge/typesafe.js";
import { resetJudgeCache, resolveMode } from "../judge/resolve.js";
import type { FetchLike } from "../judge/typesafe.js";
import type { OwnerState } from "../owner.js";

const swarmResponse = () =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        mode: { type: "choice", choice: "swarm", confidence: 0.9, probabilities: {} },
        decomposable: { type: "noul", noul: 1.0 },
      },
    }),
    { status: 200 },
  );

const okTypesafe: FetchLike = async (url) => {
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  return swarmResponse();
};

const slow: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    // Honest hang: never settles on its own; only abort can break it.
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

const deaf: FetchLike = () =>
  new Promise(() => {
    // Misbehaving transport: ignores the abort signal entirely.
  });

const badJson: FetchLike = async () => new Response("<html>nope</html>", { status: 200 });

const invalidMode: FetchLike = async () =>
  new Response(
    JSON.stringify({ answers: { mode: { choice: "vibes", confidence: 0.99 } } }),
    { status: 200 },
  );

const httpError: FetchLike = async () => new Response("server exploded", { status: 500 });

function settings(overrides: Partial<typeof DEFAULT_SETTINGS> = {}, judge: Partial<typeof DEFAULT_SETTINGS.judge> = {}) {
  // Native systemone is the TEST default (these cases mock /v1/systemone);
  // runtime default is "openrouter" — covered by the provider-table test below.
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    judge: { ...DEFAULT_SETTINGS.judge, provider: "typesafe" as const, ...judge },
  };
}

const owner = (kind: OwnerState["kind"]): OwnerState => ({
  ownerId: "o1",
  kind,
  label: "x",
  status: "active",
  revision: 3,
  lease: { ownerId: "o1", generation: 0 },
  updatedAt: new Date().toISOString(),
});

// ── typesafe.ts ──────────────────────────────────────────────────────────

test("typesafe transport parses choice + confidence", async () => {
  const transport = createTypesafeTransport({
    settings: settings().judge,
    fetchImpl: okTypesafe,
    env: { TYPESAFE_API_KEY: "k" },
  });
  const answer = await askJudge(transport, "review 6 packages", 5_000);
  assert.deepEqual(answer, { mode: "swarm", confidence: 0.9 });
});

test("buildQuestions contains the mode choice and decomposable noul", () => {
  const q = buildQuestions() as Record<string, Record<string, unknown>>;
  assert.equal(q.mode.type, "choice");
  assert.equal(q.decomposable.type, "noul");
  assert.deepEqual(Object.keys(q.mode.criteria ?? {}), ["goal", "ralph", "swarm", "graph", "none"]);
});

test("askJudge times out and fails open", async () => {
  const transport = createTypesafeTransport({
    settings: settings().judge,
    fetchImpl: slow,
    env: { TYPESAFE_API_KEY: "k" },
  });
  const answer = await askJudge(transport, "x", 30);
  assert.equal(answer, null);
});

test("askJudge survives a signal-ignoring transport (race, not await)", async () => {
  const transport = createTypesafeTransport({
    settings: settings().judge,
    fetchImpl: deaf,
    env: { TYPESAFE_API_KEY: "k" },
  });
  const answer = await askJudge(transport, "x", 30);
  assert.equal(answer, null);
});

test("non-JSON, invalid mode, and HTTP errors all fail open", async () => {
  const env = { TYPESAFE_API_KEY: "k" };
  for (const fetchImpl of [badJson, invalidMode, httpError]) {
    const transport = createTypesafeTransport({ settings: settings().judge, fetchImpl, env });
    assert.equal(await askJudge(transport, "x", 5_000), null);
  }
});

test("missing API key disables the transport (no call made)", async () => {
  let called = false;
  const transport = createTypesafeTransport({
    settings: settings().judge,
    fetchImpl: async () => {
      called = true;
      throw new Error("should not be called");
    },
    env: {},
  });
  assert.equal(await askJudge(transport, "x", 5_000), null);
  assert.equal(called, false);
});

// ── resolve.ts ladder ────────────────────────────────────────────────────

test("ladder 1: explicit override beats owner and judge", async () => {
  const resolution = await resolveMode({
    settings: settings(),
    activeOwner: owner("goal"),
    explicit: "swarm",
    prompt: "anything",
  });
  assert.deepEqual(resolution, { mode: "swarm", source: "explicit" });
});

test("ladder 2: active owner wins without consulting the judge", async () => {
  let called = false;
  const resolution = await resolveMode({
    settings: settings(),
    activeOwner: owner("ralph-loop"),
    prompt: "looks like swarm work",
    fetchImpl: async () => {
      called = true;
      throw new Error("judge must not be called");
    },
    env: { TYPESAFE_API_KEY: "k" },
  });
  assert.deepEqual(resolution, { mode: "ralph", source: "owner" });
  assert.equal(called, false);
});

test("ladder 3: judge answers above threshold", async () => {
  resetJudgeCache();
  const resolution = await resolveMode({
    settings: settings({}, { enabled: true }),
    prompt: "review these six packages in parallel",
    fetchImpl: okTypesafe,
    env: { TYPESAFE_API_KEY: "k" },
  });
  assert.deepEqual(resolution, { mode: "swarm", source: "judge", confidence: 0.9 });
});

test("ladder 3: low confidence abstains to default mode", async () => {
  resetJudgeCache();
  const lowConfidence: FetchLike = async () =>
    new Response(
      JSON.stringify({ answers: { mode: { choice: "graph", confidence: 0.3 } } }),
      { status: 200 },
    );
  const resolution = await resolveMode({
    settings: settings({}, { enabled: true }),
    prompt: "ambiguous prompt",
    fetchImpl: lowConfidence,
    env: { TYPESAFE_API_KEY: "k" },
  });
  assert.deepEqual(resolution, {
    mode: "goal",
    source: "judge_abstained_low_confidence",
    confidence: 0.3,
  });
});

test("ladder 4: judge disabled → default mode, no network", async () => {
  const resolution = await resolveMode({
    settings: settings(),
    prompt: "anything",
    fetchImpl: async () => {
      throw new Error("judge disabled; no call");
    },
    env: {},
  });
  assert.deepEqual(resolution, { mode: "goal", source: "default" });
});

test("continuations (no prompt) skip the judge entirely", async () => {
  const resolution = await resolveMode({
    settings: settings(),
    fetchImpl: async () => {
      throw new Error("no prompt; no call");
    },
    env: { TYPESAFE_API_KEY: "k" },
  });
  assert.deepEqual(resolution, { mode: "goal", source: "default" });
});

test("judge failure fails open to default", async () => {
  resetJudgeCache();
  const resolution = await resolveMode({
    settings: settings(),
    prompt: "x",
    fetchImpl: slow,
    env: { TYPESAFE_API_KEY: "k" },
  });
  assert.deepEqual(resolution, { mode: "goal", source: "default" });
});

test("cache: identical prompt within TTL does not hit the transport twice", async () => {
  resetJudgeCache();
  let calls = 0;
  const counting: FetchLike = async () => {
    calls += 1;
    return swarmResponse();
  };
  const deps = {
    settings: settings({}, { enabled: true }),
    prompt: "cached prompt",
    fetchImpl: counting,
    env: { TYPESAFE_API_KEY: "k" },
  };
  const first = await resolveMode(deps);
  const second = await resolveMode(deps);
  assert.equal(first.source, "judge");
  assert.equal(second.source, "judge");
  assert.equal(calls, 1);
});

test("provider table: typesafe native; openrouter and custom ride the openrouter shape", async () => {
  const { createJudgeTransport, effectiveProvider } = await import("../judge/typesafe.js");
  const base = { threshold: 0.6, timeoutMs: 0, apiKey: "", baseUrl: "" };
  // explicit native honored
  const native = { ...base, enabled: true, provider: "typesafe" as const, model: "jev-latest" };
  assert.equal(effectiveProvider(native), "typesafe");
  assert.equal(createJudgeTransport({ settings: native }).provider, "typesafe");
  // openrouter: jev-shaped model → decisions endpoint, chat model → chat shape
  const jev = { ...base, enabled: true, provider: "openrouter" as const, model: "typesafe/jev-1.13" };
  assert.equal(effectiveProvider(jev), "openrouter");
  assert.equal(createJudgeTransport({ settings: jev }).provider, "openrouter");
  const chat = { ...base, enabled: true, provider: "openrouter" as const, model: "zai/glm-5.3-flash" };
  assert.equal(createJudgeTransport({ settings: chat }).provider, "openrouter");
  // custom rides the openrouter shape against its own baseUrl
  const custom = { ...base, enabled: true, provider: "custom" as const, model: "typesafe/jev-1.13", baseUrl: "https://gw.example/v1" };
  assert.equal(effectiveProvider(custom), "openrouter");
  assert.equal(createJudgeTransport({ settings: custom }).provider, "openrouter");
});

test("custom provider with empty baseUrl is unconfigured — fails open with no network", async () => {
  const { createJudgeTransport } = await import("../judge/typesafe.js");
  const base = { threshold: 0.6, timeoutMs: 0, apiKey: "", baseUrl: "" };
  const custom = { ...base, enabled: true, provider: "custom" as const, model: "typesafe/jev-1.13", baseUrl: "   " };
  let calls = 0;
  const transport = createJudgeTransport({
    settings: custom,
    env: { OPENROUTER_API_KEY: "k" },
    fetchImpl: async () => {
      calls++;
      throw new Error("must not fetch");
    },
  });
  assert.equal(await transport.ask("state", new AbortController().signal), null, "fail-open null");
  assert.equal(calls, 0, "no request is attempted");
});

test("custom provider with a baseUrl targets it (version-segment root)", async () => {
  const { createJudgeTransport } = await import("../judge/typesafe.js");
  const base = { threshold: 0.6, timeoutMs: 0, apiKey: "", baseUrl: "" };
  const custom = { ...base, enabled: true, provider: "custom" as const, model: "zai/glm-5.3-flash", baseUrl: "https://gw.example/v1" };
  const urls: string[] = [];
  const transport = createJudgeTransport({
    settings: custom,
    env: { OPENROUTER_API_KEY: "k" },
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"mode":"goal","confidence":0.9}' } }] }), { status: 200 });
    }) as typeof fetch,
  });
  const answer = await transport.ask("state", new AbortController().signal);
  assert.equal(answer?.mode, "goal");
  assert.deepEqual(urls, ["https://gw.example/v1/chat/completions"]);
});
