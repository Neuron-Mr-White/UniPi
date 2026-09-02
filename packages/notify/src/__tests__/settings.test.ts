/**
 * Test: loadConfig() must return a deep copy of the defaults.
 *
 * Regression: the no-file path used `return { ...DEFAULT_CONFIG }` (shallow),
 * so nested objects (events, native, silenceAfterInput, …) were shared with
 * the module-level DEFAULT_CONFIG. Mutating a loaded config — e.g. toggling
 * rows in the settings overlay and then pressing Esc — leaked into every
 * later loadConfig() call. Caught by the PR #33 TUI test suite.
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../../settings.ts";
import type { NotifyConfig } from "../../types.ts";

const REAL_HOME = process.env.HOME;
let home = "";

function freshHome(): string {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), "notify-settings-test-"));
  process.env.HOME = home;
  return home;
}

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  process.env.HOME = REAL_HOME;
});

describe("loadConfig deep copy", () => {
  beforeEach(() => {
    freshHome();
  });

  it("no-file path: mutating the result does not pollute later loads", () => {
    const config = loadConfig();
    config.silenceAfterInput.platforms.push("gotify");
    config.silenceAfterInput.enabled = true;
    config.native.enabled = false;
    config.events.permission_request.enabled = true;
    config.events.permission_request.platforms.push("telegram");

    const reloaded = loadConfig();
    assert.deepEqual(reloaded.silenceAfterInput.platforms, ["native"]);
    assert.equal(reloaded.silenceAfterInput.enabled, false);
    assert.equal(reloaded.native.enabled, true);
    assert.equal(reloaded.events.permission_request.enabled, false);
    assert.deepEqual(reloaded.events.permission_request.platforms, []);
  });

  it("no-file path: DEFAULT_CONFIG itself is never handed out by reference", () => {
    const config = loadConfig();
    assert.notEqual(config, DEFAULT_CONFIG);
    assert.notEqual(config.events, DEFAULT_CONFIG.events);
    assert.notEqual(config.silenceAfterInput, DEFAULT_CONFIG.silenceAfterInput);
    config.events.workflow_end.enabled = false;
    assert.equal(DEFAULT_CONFIG.events.workflow_end.enabled, true);
  });

  it("merge path: nested objects from a partial file do not share with defaults", () => {
    const dir = join(home, ".unipi", "config", "notify");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ native: { enabled: true } } satisfies Partial<NotifyConfig>),
    );

    const config = loadConfig();
    assert.equal(config.native.enabled, true);
    config.events.workflow_end.enabled = false;
    config.recap.enabled = true;

    const reloaded = loadConfig();
    assert.equal(reloaded.events.workflow_end.enabled, true);
    assert.equal(reloaded.recap.enabled, false);
    assert.deepEqual(reloaded.silenceAfterInput.platforms, ["native"]);
  });

  it("save then load round-trips without cross-contamination", () => {
    const config = loadConfig();
    config.telegram.enabled = true;
    saveConfig(config);
    config.telegram.enabled = false;

    const reloaded = loadConfig();
    assert.equal(reloaded.telegram.enabled, true);
  });
});
