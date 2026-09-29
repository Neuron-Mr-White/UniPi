import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, resetSettingsCache, saveSettings } from "../settings.js";
import { resetSettingsGates } from "@pi-unipi/core";

const originalHome = process.env.HOME;

function sandboxHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-settings-"));
  process.env.HOME = dir;
  resetSettingsCache();
  // The engine's migration gate latches per-process; each sandboxed HOME
  // must be allowed to run its own (one-time) legacy import.
  resetSettingsGates();
  return dir;
}

function writeSettings(dir: string, data: unknown): string {
  const path = join(dir, ".pi", "agent", "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
  return path;
}

test("defaults when no settings file exists", () => {
  const dir = sandboxHome();
  assert.deepEqual(loadSettings(true), DEFAULT_SETTINGS);
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("new-user defaults: judge off, threshold 0.8, default mode none", () => {
  assert.equal(DEFAULT_SETTINGS.judge.enabled, false);
  assert.equal(DEFAULT_SETTINGS.judge.threshold, 0.8);
  assert.equal(DEFAULT_SETTINGS.defaultMode, "none");
});

test("reads unipi.longHorizon from the shared settings file", () => {
  const dir = sandboxHome();
  writeSettings(dir, { unipi: { longHorizon: { judge: { enabled: true, provider: "openrouter" }, defaultMode: "swarm" } } });
  const settings = loadSettings(true);
  assert.equal(settings.judge.enabled, true);
  assert.equal(settings.judge.provider, "openrouter");
  // Untouched judge keys fall back to defaults (provider-aware model).
  assert.equal(settings.judge.model, "typesafe/jev-1.13");
  assert.equal(settings.judge.threshold, 0.8);
  assert.equal(settings.defaultMode, "swarm");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("saveSettings writes the engine file and never touches sibling modules", () => {
  const dir = sandboxHome();
  const path = writeSettings(dir, { unipi: { askUser: { enabled: false } }, other: 1 });
  const next = saveSettings({ defaultMode: "none", judge: { threshold: 0.8 } });
  assert.equal(next.defaultMode, "none");
  assert.equal(next.judge.threshold, 0.8);
  assert.equal(next.judge.enabled, false);
  // The engine namespace file holds the update…
  const engineFile = join(dir, ".unipi", "config", "long-horizon", "config.json");
  const onEngine = JSON.parse(readFileSync(engineFile, "utf-8"));
  assert.equal(onEngine.defaultMode, "none");
  // …while the legacy shared file is left exactly as the migration found it —
  // namespacing makes "preserve sibling keys" structural, not a merge dance.
  const onDisk = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(onDisk.unipi.askUser, { enabled: false });
  assert.equal(onDisk.other, 1);
  assert.equal(onDisk.unipi.longHorizon, undefined);
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

function writeDecisionModel(dir: string, data: unknown): void {
  const path = join(dir, ".unipi", "config", "decision-model", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

test("invalid stored values are repaired to defaults", () => {
  const dir = sandboxHome();
  writeSettings(dir, { unipi: { longHorizon: { judge: { threshold: 5, provider: "bogus" }, defaultMode: "weird" } } });
  const settings = loadSettings(true);
  assert.equal(settings.judge.threshold, 0.8);
  // An unknown provider falls back to the Decision Model default transport.
  assert.equal(settings.judge.provider, "openrouter");
  assert.equal(settings.defaultMode, "none");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("stored provider \"auto\" migrates to \"openrouter\" (its effective transport)", () => {
  const dir = sandboxHome();
  writeSettings(dir, { unipi: { longHorizon: { judge: { provider: "auto" } } } });
  const settings = loadSettings(true);
  assert.equal(settings.judge.provider, "openrouter");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("empty model defaults per provider: jev-latest native, hosted id for gateways", () => {
  const dir = sandboxHome();
  writeDecisionModel(dir, { provider: "typesafe", model: "" });
  assert.equal(loadSettings(true).judge.model, "jev-latest", "native typesafe speaks bare ids");
  resetSettingsCache();
  writeDecisionModel(dir, { provider: "custom", model: "" });
  assert.equal(loadSettings(true).judge.model, "typesafe/jev-1.13", "gateways use the hosted jev id");
  resetSettingsCache();
  writeDecisionModel(dir, {});
  assert.equal(loadSettings(true).judge.model, "typesafe/jev-1.13", "runtime default (openrouter) uses the hosted id");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("provider \"custom\" is accepted and round-trips", () => {
  const dir = sandboxHome();
  writeSettings(dir, { unipi: { longHorizon: { judge: { provider: "custom", baseUrl: "https://gw.example/v1" } } } });
  const settings = loadSettings(true);
  assert.equal(settings.judge.provider, "custom");
  assert.equal(settings.judge.baseUrl, "https://gw.example/v1");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("the judge transport comes from the shared Decision Model unless long-horizon sets a custom one", () => {
  const dir = sandboxHome();
  writeDecisionModel(dir, { provider: "typesafe", model: "jev-latest", apiKey: "shared" });
  let settings = loadSettings(true);
  assert.equal(settings.judge.provider, "typesafe");
  assert.equal(settings.judge.apiKey, "shared");
  resetSettingsCache();
  const lh = join(dir, ".unipi", "config", "long-horizon", "config.json");
  mkdirSync(dirname(lh), { recursive: true });
  writeFileSync(lh, JSON.stringify({ decisionModel: { source: "custom", provider: "openrouter", model: "typesafe/jev-1.13" } }));
  settings = loadSettings(true);
  assert.equal(settings.judge.provider, "openrouter");
  assert.equal(settings.judge.apiKey, "shared", "empty custom fields fall back to the shared value");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});
