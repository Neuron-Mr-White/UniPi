import { strict as assert } from "node:assert";
import { test } from "node:test";
import { judgeEnv, judgeKeyVar, registryKey, type JudgeKeyRegistry } from "../judge/credentials.js";
import { resetJudgeCache, resolveMode } from "../judge/resolve.js";
import { DEFAULT_SETTINGS } from "../settings.js";

const s = (o: Partial<{ provider: "typesafe" | "openrouter" | "custom"; baseUrl: string; apiKey: string }> = {}) => ({
  provider: "openrouter" as const,
  baseUrl: "",
  apiKey: "",
  ...o,
});

const registry = (opts: { models?: Array<{ provider: string; id: string; baseUrl?: string }>; keys?: Record<string, string> } = {}): JudgeKeyRegistry & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    getAll: () => opts.models ?? [],
    getApiKeyAndHeaders: async (m: never) => {
      const model = m as unknown as { provider: string };
      asked.push(`model:${model.provider}`);
      const key = opts.keys?.[model.provider];
      return key ? { ok: true, apiKey: key } : { ok: false };
    },
    getApiKeyForProvider: async (p: string) => {
      asked.push(`provider:${p}`);
      return opts.keys?.[p];
    },
  };
};

test("judgeKeyVar maps providers to their env var", () => {
  assert.equal(judgeKeyVar("typesafe"), "TYPESAFE_API_KEY");
  assert.equal(judgeKeyVar("openrouter"), "OPENROUTER_API_KEY");
  assert.equal(judgeKeyVar("custom"), "OPENROUTER_API_KEY");
});

test("stored key wins over env and registry", async () => {
  const reg = registry({ keys: { openrouter: "reg" } });
  const env = await judgeEnv(s({ apiKey: " stored " }), { OPENROUTER_API_KEY: "env" }, reg);
  assert.equal(env.OPENROUTER_API_KEY, "stored");
  assert.deepEqual(reg.asked, []);
});

test("env wins over the registry", async () => {
  const reg = registry({ keys: { openrouter: "reg" } });
  const env = await judgeEnv(s(), { OPENROUTER_API_KEY: "env" }, reg);
  assert.equal(env.OPENROUTER_API_KEY, "env");
  assert.deepEqual(reg.asked, []);
});

test("no explicit key: pi's stored key for the judge provider is used", async () => {
  const env = await judgeEnv(s(), {}, registry({ keys: { openrouter: "reg" } }));
  assert.equal(env.OPENROUTER_API_KEY, "reg");
  const ts = await judgeEnv(s({ provider: "typesafe" }), {}, registry({ keys: { typesafe: "t" } }));
  assert.equal(ts.TYPESAFE_API_KEY, "t");
});

test("a baseUrl resolves through whichever pi provider serves that endpoint", async () => {
  const reg = registry({
    models: [
      { provider: "other", id: "a", baseUrl: "https://elsewhere/v1" },
      { provider: "my-gateway", id: "b", baseUrl: "https://gw.example/v1/" },
    ],
    keys: { "my-gateway": "gw-key", openrouter: "or-key" },
  });
  const env = await judgeEnv(s({ provider: "custom", baseUrl: "https://GW.example/v1" }), {}, reg);
  assert.equal(env.OPENROUTER_API_KEY, "gw-key");
  assert.deepEqual(reg.asked, ["model:my-gateway"]);
});

test("a baseUrl with no matching pi provider never borrows another provider's key", async () => {
  const reg = registry({ keys: { openrouter: "or-key" } });
  assert.equal(await registryKey(s({ baseUrl: "https://unknown/v1" }), reg), undefined);
  assert.equal(await registryKey(s({ provider: "custom" }), reg), undefined);
});

test("registry failures and absence fail open", async () => {
  assert.equal(await registryKey(s(), undefined), undefined);
  const broken: JudgeKeyRegistry = { getApiKeyForProvider: async () => { throw new Error("boom"); } };
  assert.equal(await registryKey(s(), broken), undefined);
  const env = await judgeEnv(s(), { X: "1" }, broken);
  assert.deepEqual(env, { X: "1" });
});

test("resolveMode uses the registry key when nothing else is configured", async () => {
  resetJudgeCache();
  let auth = "";
  const resolution = await resolveMode({
    settings: { ...DEFAULT_SETTINGS, judge: { ...DEFAULT_SETTINGS.judge, enabled: true, provider: "openrouter", model: "typesafe/jev-1.13", apiKey: "", baseUrl: "" } },
    prompt: "registry key prompt",
    env: {},
    registry: registry({ keys: { openrouter: "reg" } }),
    fetchImpl: async (_url, init) => {
      auth = String((init.headers as Record<string, string>).authorization ?? (init.headers as Record<string, string>).Authorization ?? "");
      return new Response(JSON.stringify({ answers: { mode: { choice: "graph", confidence: 0.95 } } }), { status: 200 });
    },
  });
  assert.equal(resolution.source, "judge");
  assert.equal(resolution.mode, "graph");
  assert.match(auth, /reg$/);
});

test("resolveMode without any key stays on the default mode with no network", async () => {
  resetJudgeCache();
  const resolution = await resolveMode({
    settings: { ...DEFAULT_SETTINGS, judge: { ...DEFAULT_SETTINGS.judge, enabled: true, provider: "openrouter", apiKey: "" } },
    prompt: "no key prompt",
    env: {},
    registry: registry(),
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(resolution.source, "default");
});
