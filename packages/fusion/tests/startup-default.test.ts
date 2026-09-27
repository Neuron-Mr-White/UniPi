import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox pi's settings dir and ~/.unipi before anything reads them.
const HOME = mkdtempSync(join(tmpdir(), "fusion-startup-"));
const PI_DIR = join(HOME, ".pi", "agent");
mkdirSync(PI_DIR, { recursive: true });
process.env.HOME = HOME;
process.env.PI_CODING_AGENT_DIR = PI_DIR;

import { ModelPicker, type PickerResult, type PickerState } from "../src/picker.js";
import { applyStartupSettings, mirrorStartupFromPi, globalPresetPath, saveRuntimeState, loadPreset } from "../src/preset.js";
import { readDefaultModel } from "../src/pi-settings.js";
import { getSettingsScoped, registerSettings, setSettings, unsetSettings } from "@pi-unipi/core";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const ALT_ENTER = "\x1b\r";
const CTRL_S = "\x13";
const piSettings = () => JSON.parse(readFileSync(join(PI_DIR, "settings.json"), "utf8")) as Record<string, unknown>;

function state(): PickerState {
  return {
    models: [
      { key: "a/opus", name: "Opus", provider: "a", reasoning: true },
      { key: "b/glm", name: "GLM", provider: "b", reasoning: true },
    ],
    fusionLeads: ["a/opus"],
    fusionSidekicks: ["b/glm"],
    fusionDefault: { lead: "a/opus", sidekick: "b/glm" },
    recent: [],
    active: { kind: "single", model: "b/glm" },
    currentModelKey: "b/glm",
    effort: {},
    fallbackEffort: "low",
  };
}

test("alt+enter applies the row AND saves it as the default; ctrl+s no longer does anything", () => {
  const saved: PickerResult[] = [];
  let done: PickerResult | undefined;
  const picker = new ModelPicker({ state: state(), theme, onDone: (r) => (done = r), onSetDefault: (r) => saved.push(r) });
  picker.handleInput(CTRL_S);
  assert.equal(saved.length, 0);
  assert.equal(done, undefined);
  picker.handleInput(ALT_ENTER);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.type, "single");
  assert.equal((saved[0] as { model: string }).model, "b/glm");
  assert.equal(done?.type, "single", "the picker also applies and closes");
});

test("hint line advertises alt+enter, not ctrl+s", () => {
  const picker = new ModelPicker({ state: state(), theme, onDone: () => {}, onSetDefault: () => {} });
  const text = picker.render(120).join("\n");
  assert.match(text, /alt\+enter set default/);
  assert.doesNotMatch(text, /ctrl\+s/);
});

test("engine onSet hook fires after set and unset with the layer content", () => {
  const seen: Array<{ layer: Record<string, unknown>; scope: string }> = [];
  registerSettings({ namespace: "onset-probe", label: "probe", defaults: {}, onSet: (layer, scope) => seen.push({ layer, scope }) });
  setSettings("onset-probe", { a: { b: 1 } }, "global", HOME);
  assert.deepEqual(seen.at(-1), { layer: { a: { b: 1 } }, scope: "global" });
  unsetSettings("onset-probe", "a.b", "global", HOME);
  assert.deepEqual(seen.at(-1), { layer: { a: {} }, scope: "global" });
});

test("settings → pi: startup model + thinking write pi's settings.json and drop a remembered Fusion pair", () => {
  writeFileSync(join(PI_DIR, "settings.json"), JSON.stringify({ theme: "dark", defaultProvider: "b", defaultModel: "glm" }));
  saveRuntimeState(globalPresetPath(HOME), { effort: {}, recent: [], active: { kind: "fusion", lead: "b/glm", sidekick: "c/x" } });
  assert.equal(applyStartupSettings({ startup: { model: "omniroute/ds/deepseek-flash", thinking: "high" } }, HOME), true);
  const s = piSettings();
  assert.equal(s.defaultProvider, "omniroute");
  assert.equal(s.defaultModel, "ds/deepseek-flash");
  assert.equal(s.defaultThinkingLevel, "high");
  assert.equal(s.theme, "dark", "other pi settings are preserved");
  assert.deepEqual(loadPreset(HOME, HOME).preset.active, { kind: "single", model: "omniroute/ds/deepseek-flash" });
  // Echo of pi's own value: no write.
  assert.equal(applyStartupSettings({ startup: { model: "omniroute/ds/deepseek-flash", thinking: "high" } }, HOME), false);
  // Thinking alone keeps the model.
  assert.equal(applyStartupSettings({ startup: { thinking: "low" } }, HOME), true);
  assert.deepEqual(readDefaultModel(), { key: "omniroute/ds/deepseek-flash", thinking: "low" });
});

test("pi → settings: the hub mirrors pi's current default (e.g. after pi's own /model save)", () => {
  writeFileSync(join(PI_DIR, "settings.json"), JSON.stringify({ defaultProvider: "cx", defaultModel: "gpt-5.6-luna", defaultThinkingLevel: "medium" }));
  mirrorStartupFromPi(HOME);
  assert.deepEqual(getSettingsScoped("fusion", "global", HOME)?.startup, { model: "cx/gpt-5.6-luna", thinking: "medium" });
  assert.equal(piSettings().defaultModel, "gpt-5.6-luna", "mirroring back is an echo, pi's file unchanged");
});

process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));
