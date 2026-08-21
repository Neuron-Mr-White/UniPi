/**
 * Config layering + validation tests for @pi-unipi/background-tasks.
 * Adapted from reference config/operations specs to OUR paths and layering.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadBackgroundTasksConfig,
  validateBackgroundTasksConfig,
} from "../config.js";

/** Run loadBackgroundTasksConfig with HOME pointed at a temp dir. */
function withTempHome<T>(fn: (home: string, cwd: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "unipi-bg-cfg-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "unipi-bg-cfg-ws-"));
  const realHome = process.env.HOME;
  const realUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn(home, cwd);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("defaults: enabled true, notify+wake on, 20MiB cap", () => {
  assert.equal(DEFAULT_CONFIG.enabled, true);
  assert.equal(DEFAULT_CONFIG.notifyOnCompletion, true);
  assert.equal(DEFAULT_CONFIG.triggerOnCompletion, true);
  assert.equal(DEFAULT_CONFIG.maxOutputBytes, 20 * 1024 * 1024);
  assert.equal(DEFAULT_CONFIG.delegate.extensionMode, "isolated");
});

test("first run creates the global config file", () => {
  withTempHome((home) => {
    const { config } = loadBackgroundTasksConfig("");
    assert.equal(config.enabled, true);
    const written = JSON.parse(readFileSync(join(home, ".unipi", "config", "background-tasks.json"), "utf-8"));
    assert.equal(written.enabled, true);
  });
});

test("workspace config wins over global", () => {
  withTempHome((home, cwd) => {
    const globalPath = join(home, ".unipi", "config", "background-tasks.json");
    mkdirSync(join(globalPath, ".."), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ maxFinishedTasks: 10 }));
    const wsPath = join(cwd, ".unipi", "config", "background-tasks.json");
    mkdirSync(join(wsPath, ".."), { recursive: true });
    writeFileSync(wsPath, JSON.stringify({ maxFinishedTasks: 7, triggerOnCompletion: false }));

    const { config } = loadBackgroundTasksConfig(cwd);
    assert.equal(config.maxFinishedTasks, 7);
    assert.equal(config.triggerOnCompletion, false);
    assert.equal(config.enabled, true); // untouched default
  });
});

test("corrupt layers are skipped with warnings, not crashes", () => {
  withTempHome((home, cwd) => {
    const globalPath = join(home, ".unipi", "config", "background-tasks.json");
    mkdirSync(join(globalPath, ".."), { recursive: true });
    writeFileSync(globalPath, "{not json");
    const wsPath = join(cwd, ".unipi", "config", "background-tasks.json");
    mkdirSync(join(wsPath, ".."), { recursive: true });
    writeFileSync(wsPath, "[1,2,3]");

    const { config, warnings } = loadBackgroundTasksConfig(cwd);
    assert.equal(config.enabled, true);
    assert.equal(config.maxFinishedTasks, DEFAULT_CONFIG.maxFinishedTasks);
    assert.ok(warnings.length >= 1);
  });
});

test("validation rejects bad values with visible messages", () => {
  const problems = validateBackgroundTasksConfig({
    enabled: "yes",
    maxOutputBytes: 10,
    delegate: { extensionMode: "wild" },
    fusion: { candidates: ["a"] },
  });
  assert.ok(problems.some((p) => p.includes("enabled")));
  assert.ok(problems.some((p) => p.includes("maxOutputBytes")));
  assert.ok(problems.some((p) => p.includes("extensionMode")));
  assert.ok(problems.some((p) => p.includes("candidates")));
});

test("validation accepts a full valid config", () => {
  const problems = validateBackgroundTasksConfig({
    enabled: false,
    notifyOnCompletion: false,
    triggerOnCompletion: false,
    defaultTimeoutSeconds: 600,
    maxFinishedTasks: 5,
    maxOutputBytes: 1024 * 1024,
    delegate: { extensionMode: "ambient", autoDeliver: "always", maxTurns: 10, maxToolCalls: 20, timeoutSeconds: 60 },
    fusion: { candidates: ["m1", "m2", "m3"], evaluator: "e", merger: "g" },
  });
  assert.deepEqual(problems, []);
});

test("invalid values sanitize to defaults instead of crashing the loader", () => {
  withTempHome((home) => {
    const globalPath = join(home, ".unipi", "config", "background-tasks.json");
    mkdirSync(join(globalPath, ".."), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({ enabled: "nope", maxFinishedTasks: -1, delegate: { extensionMode: "wild" } }),
    );
    const { config, warnings } = loadBackgroundTasksConfig("");
    assert.equal(config.enabled, true);
    assert.equal(config.maxFinishedTasks, DEFAULT_CONFIG.maxFinishedTasks);
    assert.equal(config.delegate.extensionMode, "isolated");
    assert.ok(warnings.length >= 1);
  });
});

test("master toggle off is preserved through load", () => {
  withTempHome((home) => {
    const globalPath = join(home, ".unipi", "config", "background-tasks.json");
    mkdirSync(join(globalPath, ".."), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ enabled: false }));
    const { config } = loadBackgroundTasksConfig("");
    assert.equal(config.enabled, false);
  });
});
