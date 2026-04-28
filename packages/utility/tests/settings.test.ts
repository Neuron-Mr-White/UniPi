/**
 * @pi-unipi/utility — Settings module tests
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We need to test against real file I/O, so we use a temp directory
let tmpDir: string;
let origCwd: string;

describe("Unified Settings", () => {
  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unipi-settings-test-"));
    process.chdir(tmpDir);
    fs.mkdirSync(".unipi/config", { recursive: true });
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("readUtilSettings returns defaults when no config exists", async () => {
    const { readUtilSettings } = await import("../src/diff/settings.js");
    const settings = readUtilSettings();
    assert.equal(settings.diff.enabled, true);
    assert.equal(settings.diff.theme, "default");
    assert.equal(settings.diff.shikiTheme, "github-dark");
    assert.equal(settings.diff.splitMinWidth, 150);
    assert.equal(settings.badge.autoGen, true);
    assert.equal(settings.badge.badgeEnabled, true);
    assert.equal(settings.badge.agentTool, true);
    assert.equal(settings.badge.generationModel, "inherit");
  });

  it("writeUtilSettings + readUtilSettings round-trips correctly", async () => {
    const { readUtilSettings, writeUtilSettings } = await import("../src/diff/settings.js");
    const custom = {
      badge: { autoGen: false, badgeEnabled: true, agentTool: false, generationModel: "openai/gpt-4o" },
      diff: { enabled: false, theme: "midnight", shikiTheme: "dracula", splitMinWidth: 120 },
    };
    writeUtilSettings(custom);
    const result = readUtilSettings();
    assert.deepEqual(result, custom);
  });

  it("readDiffSettings returns only diff section", async () => {
    const { readDiffSettings, writeUtilSettings } = await import("../src/diff/settings.js");
    writeUtilSettings({
      badge: { autoGen: false, badgeEnabled: false, agentTool: false, generationModel: "inherit" },
      diff: { enabled: false, theme: "neon", shikiTheme: "one-dark-pro", splitMinWidth: 200 },
    });
    const diff = readDiffSettings();
    assert.equal(diff.enabled, false);
    assert.equal(diff.theme, "neon");
    assert.equal(diff.shikiTheme, "one-dark-pro");
    assert.equal(diff.splitMinWidth, 200);
  });

  it("writeDiffSettings merges with existing settings", async () => {
    const { readDiffSettings, writeDiffSettings, readUtilSettings } = await import("../src/diff/settings.js");
    writeDiffSettings({ theme: "subtle" });
    const diff = readDiffSettings();
    assert.equal(diff.theme, "subtle");
    assert.equal(diff.enabled, true); // default preserved
    // Badge should be untouched
    const util = readUtilSettings();
    assert.equal(util.badge.autoGen, true);
  });

  it("migrates from badge.json on first read", async () => {
    const { readUtilSettings } = await import("../src/diff/settings.js");
    // Write legacy badge.json
    fs.writeFileSync(
      ".unipi/config/badge.json",
      JSON.stringify({ autoGen: false, badgeEnabled: true, agentTool: false, generationModel: "test/model" }),
    );
    const settings = readUtilSettings();
    assert.equal(settings.badge.autoGen, false);
    assert.equal(settings.badge.badgeEnabled, true);
    assert.equal(settings.badge.agentTool, false);
    assert.equal(settings.badge.generationModel, "test/model");
    // util-settings.json should now exist
    assert.ok(fs.existsSync(".unipi/config/util-settings.json"));
  });

  it("uses existing util-settings.json if both files exist", async () => {
    const { readUtilSettings, writeUtilSettings } = await import("../src/diff/settings.js");
    // Write both
    fs.writeFileSync(
      ".unipi/config/badge.json",
      JSON.stringify({ autoGen: false, badgeEnabled: false, agentTool: false, generationModel: "old" }),
    );
    writeUtilSettings({
      badge: { autoGen: true, badgeEnabled: true, agentTool: true, generationModel: "new" },
      diff: { enabled: true, theme: "default", shikiTheme: "github-dark", splitMinWidth: 150 },
    });
    const settings = readUtilSettings();
    assert.equal(settings.badge.generationModel, "new"); // util-settings takes priority
  });

  it("normalizeSettings handles malformed JSON gracefully", async () => {
    const { readUtilSettings, writeUtilSettings } = await import("../src/diff/settings.js");
    // Write malformed JSON
    fs.writeFileSync(".unipi/config/util-settings.json", '{ "badge": {}, "diff": {} }');
    const settings = readUtilSettings();
    // Should get defaults for missing fields
    assert.equal(settings.badge.autoGen, true);
    assert.equal(settings.diff.enabled, true);
  });
});
