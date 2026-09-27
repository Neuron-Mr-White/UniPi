import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { registerSettings, resetSettingsGates } from "./src/settings/engine.js";
import { decisionModelSection, readDecisionModel, resolveDecisionModel } from "./src/jev/settings.js";

const originalHome = process.env.HOME;

function sandbox(): { home: string; cwd: string; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "dm-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "dm-cwd-"));
  process.env.HOME = home;
  resetSettingsGates();
  return {
    home,
    cwd,
    done: () => {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const write = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
};

registerSettings({ namespace: "dm-consumer", label: "Consumer", defaults: {} });

test("defaults: jev on OpenRouter, key from the environment", () => {
  const s = sandbox();
  assert.deepEqual(readDecisionModel(s.cwd), { provider: "openrouter", model: "typesafe/jev-1.13", baseUrl: "", apiKey: "", timeoutMs: 0 });
  s.done();
});

test("a consumer inherits the shared model unless its block says custom", () => {
  const s = sandbox();
  write(join(s.home, ".unipi", "config", "decision-model", "config.json"), { provider: "typesafe", model: "jev-latest", apiKey: "shared-key" });
  assert.equal(resolveDecisionModel(s.cwd, "dm-consumer").provider, "typesafe");
  write(join(s.home, ".unipi", "config", "dm-consumer", "config.json"), { decisionModel: { source: "inherit", provider: "custom", model: "x" } });
  assert.equal(resolveDecisionModel(s.cwd, "dm-consumer").provider, "typesafe", "inherit ignores the custom fields");
  write(join(s.home, ".unipi", "config", "dm-consumer", "config.json"), {
    decisionModel: { source: "custom", provider: "custom", model: "", baseUrl: "https://gw.example/v1", apiKey: "" },
  });
  const custom = resolveDecisionModel(s.cwd, "dm-consumer");
  assert.equal(custom.provider, "custom");
  assert.equal(custom.baseUrl, "https://gw.example/v1");
  assert.equal(custom.model, "typesafe/jev-1.13", "empty model → the provider's default id");
  assert.equal(custom.apiKey, "shared-key", "empty key → the shared key");
  s.done();
});

test("migrates the old long-horizon judge transport once, leaving long-horizon untouched", () => {
  const s = sandbox();
  const lh = join(s.home, ".unipi", "config", "long-horizon", "config.json");
  write(lh, { judge: { enabled: true, provider: "custom", model: "typesafe/jev-1.13", baseUrl: "https://gw.example/v1", apiKey: "old", threshold: 0.6 } });
  const dm = readDecisionModel(s.cwd);
  assert.equal(dm.provider, "custom");
  assert.equal(dm.apiKey, "old");
  const file = JSON.parse(readFileSync(join(s.home, ".unipi", "config", "decision-model", "config.json"), "utf-8"));
  assert.deepEqual(file, { provider: "custom", model: "typesafe/jev-1.13", baseUrl: "https://gw.example/v1", apiKey: "old" });
  assert.equal(JSON.parse(readFileSync(lh, "utf-8")).judge.threshold, 0.6);
  s.done();
});

test("the consumer section offers inherit/custom and the custom fields", () => {
  const section = decisionModelSection({ title: "X" });
  assert.equal(section.advanced, true);
  assert.deepEqual(
    section.fields.map((f) => f.key),
    ["decisionModel.source", "decisionModel.provider", "decisionModel.model", "decisionModel.baseUrl", "decisionModel.apiKey", "decisionModel.timeoutMs"],
  );
});
