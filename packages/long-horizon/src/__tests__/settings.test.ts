import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, loadSettings, resetSettingsCache, saveSettings } from "../settings.js";

const originalHome = process.env.HOME;

function sandboxHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lh-settings-"));
  process.env.HOME = dir;
  resetSettingsCache();
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

test("reads unipi.longHorizon from the shared settings file", () => {
  const dir = sandboxHome();
  writeSettings(dir, { unipi: { longHorizon: { judge: { enabled: true, provider: "openrouter" }, defaultMode: "swarm" } } });
  const settings = loadSettings(true);
  assert.equal(settings.judge.enabled, true);
  assert.equal(settings.judge.provider, "openrouter");
  // Untouched judge keys fall back to defaults.
  assert.equal(settings.judge.model, "jev-latest");
  assert.equal(settings.judge.threshold, 0.6);
  assert.equal(settings.defaultMode, "swarm");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("saveSettings merges and preserves sibling modules' keys", () => {
  const dir = sandboxHome();
  const path = writeSettings(dir, { unipi: { askUser: { enabled: false } }, other: 1 });
  const next = saveSettings({ defaultMode: "none", judge: { threshold: 0.8 } });
  assert.equal(next.defaultMode, "none");
  assert.equal(next.judge.threshold, 0.8);
  assert.equal(next.judge.enabled, false);
  const onDisk = JSON.parse(readFileSync(path, "utf-8"));
  assert.deepEqual(onDisk.unipi.askUser, { enabled: false });
  assert.equal(onDisk.other, 1);
  assert.equal(onDisk.unipi.longHorizon.defaultMode, "none");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});

test("invalid stored values are repaired to defaults", () => {
  const dir = sandboxHome();
  writeSettings(dir, { unipi: { longHorizon: { judge: { threshold: 5, provider: "bogus" }, defaultMode: "weird" } } });
  const settings = loadSettings(true);
  assert.equal(settings.judge.threshold, 0.6);
  assert.equal(settings.judge.provider, "typesafe");
  assert.equal(settings.defaultMode, "goal");
  process.env.HOME = originalHome;
  resetSettingsCache();
  rmSync(dir, { recursive: true, force: true });
});
