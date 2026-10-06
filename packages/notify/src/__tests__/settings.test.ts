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
  home = mkdtempSync(join(tmpdir(), "notify-hub-test-"));
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
    config.events.ralph_loop_end.enabled = false;
    assert.equal(DEFAULT_CONFIG.events.ralph_loop_end.enabled, true);
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
    config.events.ralph_loop_end.enabled = false;
    config.recap.enabled = true;

    const reloaded = loadConfig();
    assert.equal(reloaded.events.ralph_loop_end.enabled, true);
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

describe("DEFAULT_CONFIG events", () => {
  it("defines input_needed, disabled by default", () => {
    assert.deepEqual(DEFAULT_CONFIG.events.input_needed, {
      enabled: false,
      platforms: [],
    });
  });

  it("drops removed event keys from an old saved config silently", () => {
    const dir = join(home, ".unipi", "config", "notify");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        events: {
          // Removed in the bus migration — must be ignored, not re-saved.
          workflow_end: { enabled: true, platforms: ["native"] },
          memory_consolidated: { enabled: true, platforms: [] },
          update_error: { enabled: true, platforms: [] },
          ralph_loop_end: { enabled: false, platforms: ["gotify"] },
        },
      } satisfies Partial<NotifyConfig>),
    );

    const config = loadConfig();
    assert.equal(config.events.workflow_end, undefined);
    assert.equal(config.events.memory_consolidated, undefined);
    assert.equal(config.events.update_error, undefined);
    assert.deepEqual(config.events.ralph_loop_end, { enabled: false, platforms: ["gotify"] });

    // Saving the loaded config keeps the dropped keys out of the save patch:
    // a later loadConfig stays clean and known keys survive.
    saveConfig(config);
    const reloaded = loadConfig();
    assert.equal(reloaded.events.workflow_end, undefined);
    assert.equal(reloaded.events.memory_consolidated, undefined);
    assert.equal(reloaded.events.update_error, undefined);
    assert.deepEqual(reloaded.events.ralph_loop_end, { enabled: false, platforms: ["gotify"] });
  });
});
