/**
 * `recall` level migration + derivation (UNI-50 R1).
 *
 * The stored layers (never the defaults-merged object) decide the effective
 * `recall`; legacy `recallAtStart`/`wakeUp` booleans derive it per scope, and
 * migrateRecallLevel writes the derived key back additively once.
 *
 * HOME is pinned so the machine's global scope is never read or written.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsGates, setSettings } from "@pi-unipi/core";

import { migrateRecallLevel, readMemoryConfig } from "../settings.js";
import "../settings.js"; // register the namespace

const HOME = mkdtempSync(join(tmpdir(), "recall-home-"));
const CWD = mkdtempSync(join(tmpdir(), "recall-cwd-"));
const CONFIG_FILE = join(CWD, ".unipi", "config", "memory", "config.json");
let prevHome: string | undefined;

before(() => {
  prevHome = process.env.HOME;
  process.env.HOME = HOME;
  resetSettingsGates();
});

after(() => {
  process.env.HOME = prevHome;
  rmSync(HOME, { recursive: true, force: true });
  rmSync(CWD, { recursive: true, force: true });
});

function writeProjectConfig(config: Record<string, unknown>): void {
  mkdirSync(join(CWD, ".unipi", "config", "memory"), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

function storedProjectConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

test("legacy recallAtStart:false → recall off, internal booleans false", () => {
  writeProjectConfig({ recallAtStart: false });
  const config = readMemoryConfig(CWD);
  assert.equal(config.recall, "off");
  assert.equal(config.recallAtStart, false);
  assert.equal(config.wakeUp, false);
  rmSync(CONFIG_FILE, { force: true });
});

test("legacy wakeUp:false (recall on) → recall reminder", () => {
  writeProjectConfig({ recallAtStart: true, wakeUp: false });
  const config = readMemoryConfig(CWD);
  assert.equal(config.recall, "reminder");
  assert.equal(config.recallAtStart, true);
  assert.equal(config.wakeUp, false);
  rmSync(CONFIG_FILE, { force: true });
});

test("both keys present: the new recall wins", () => {
  writeProjectConfig({ recall: "reminder", recallAtStart: false });
  const config = readMemoryConfig(CWD);
  assert.equal(config.recall, "reminder");
  assert.equal(config.recallAtStart, true);
  assert.equal(config.wakeUp, false);
  rmSync(CONFIG_FILE, { force: true });
});

test("nothing stored: defaults apply", () => {
  const config = readMemoryConfig(CWD);
  assert.equal(config.recall, "wake-up");
  assert.equal(config.recallAtStart, true);
  assert.equal(config.wakeUp, true);
});

test("migrateRecallLevel writes the derived level once, additively", () => {
  writeProjectConfig({ recallAtStart: false });
  migrateRecallLevel(CWD);
  const stored = storedProjectConfig();
  assert.equal(stored.recall, "off");
  assert.equal(stored.recallAtStart, false, "legacy key stays untouched");
  // Second run is a no-op (the layer now carries the new key).
  stored.recall = "wake-up";
  writeProjectConfig(stored);
  migrateRecallLevel(CWD);
  assert.equal(storedProjectConfig().recall, "wake-up");
  rmSync(CONFIG_FILE, { force: true });
});

test("project layer wins over global", () => {
  setSettings("memory", { recall: "reminder" }, "project", CWD);
  const config = readMemoryConfig(CWD);
  assert.equal(config.recall, "reminder");
  rmSync(CONFIG_FILE, { force: true });
});
